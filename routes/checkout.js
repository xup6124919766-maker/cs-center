/**
 * routes/checkout.js — 結帳連結 API endpoints
 *
 * 需登入：
 *   GET  /api/products?client_id=
 *   POST /api/checkout-links
 *   GET  /api/checkout-links?conversation_id=&client_id=
 *   GET  /api/checkout-links/:id/stats
 *
 * 公開：
 *   GET  /go/:code  → 重定向 + count++（在 server.js 直接掛，不走這個 router）
 *
 * Admin 設定（需 admin 角色）：
 *   PUT  /api/checkout/template
 *   PUT  /api/checkout/catalog
 *   POST /api/checkout/catalog/import-csv
 */

import { Router } from 'express';
import {
  generateCheckoutLink, recordClick, getCheckoutLink,
  listCheckoutLinks, getCheckoutLinkStats,
  getClientProducts, setProductCatalog, setCartUrlTemplate,
} from '../lib/checkout.js';
import { requireAuth, requireAdmin } from '../lib/auth.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ module: 'routes/checkout' });
const router = Router();

// 所有 checkout 路由都需要登入
router.use(requireAuth);

// ─── GET /api/products?client_id= ───
// 取得業主商品列表（給 inbox modal 用）
router.get('/products', (req, res) => {
  const clientId = req.session.role === 'admin'
    ? parseInt(req.query.client_id, 10) || req.session.client_id
    : req.session.client_id;

  if (!clientId) return res.status(400).json({ error: '缺少 client_id' });

  const products = getClientProducts(clientId);
  res.json({ products });
});

// ─── POST /api/checkout-links ───
// body: { client_id?(admin only), conversation_id?, items: [{ sku, qty, price? }] }
router.post('/checkout-links', (req, res) => {
  const clientId = req.session.role === 'admin' && req.body?.client_id
    ? parseInt(req.body.client_id, 10)
    : req.session.client_id;
  if (!clientId) return res.status(400).json({ error: '需要 client_id（請確認帳號設定）' });

  const { conversation_id, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '缺少 items 或 items 為空' });
  }

  // 驗證 items 格式
  for (const item of items) {
    if (!item.sku) return res.status(400).json({ error: `商品 SKU 不可為空` });
    if (!item.qty || item.qty < 1) return res.status(400).json({ error: `商品數量需大於 0` });
  }

  try {
    const link = generateCheckoutLink({
      client_id: clientId,
      conversation_id: conversation_id ? parseInt(conversation_id, 10) : null,
      items,
      user_id: req.session.user_id,
    });
    res.json({ ok: true, ...link });
  } catch (e) {
    log.error({ err: e.message, client_id: clientId }, 'checkout link generate failed');
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/checkout-links?conversation_id=&client_id= ───
router.get('/checkout-links', (req, res) => {
  const clientId = req.session.role === 'admin'
    ? parseInt(req.query.client_id, 10) || req.session.client_id
    : req.session.client_id;

  if (!clientId) return res.status(400).json({ error: '缺少 client_id' });

  const links = listCheckoutLinks({
    client_id: clientId,
    conversation_id: req.query.conversation_id ? parseInt(req.query.conversation_id, 10) : null,
    limit: parseInt(req.query.limit, 10) || 50,
    offset: parseInt(req.query.offset, 10) || 0,
  });
  res.json({ links });
});

// ─── GET /api/checkout-links/:id/stats ───
router.get('/checkout-links/:id/stats', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stats = getCheckoutLinkStats(id);
  if (!stats) return res.status(404).json({ error: '連結不存在' });

  // 權限：只能看自己業主的
  if (req.session.role !== 'admin') {
    const link = getCheckoutLink(id);
    if (!link || link.client_id !== req.session.client_id) {
      return res.status(403).json({ error: '無權限' });
    }
  }

  res.json(stats);
});

// ─── Admin: PUT /api/checkout/template ───
// body: { client_id, template }
router.put('/checkout/template', requireAdmin, (req, res) => {
  const { client_id, template } = req.body || {};
  if (!client_id || !template) return res.status(400).json({ error: '缺少 client_id 或 template' });
  if (!template.includes('{sku}') && !template.includes('{items}')) {
    return res.status(400).json({ error: 'template 需包含 {sku} 或 {items} placeholder' });
  }

  try {
    setCartUrlTemplate(parseInt(client_id, 10), template);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin: PUT /api/checkout/catalog ───
// body: { client_id, products: [{ sku, name, price, image_url, description }] }
router.put('/checkout/catalog', requireAdmin, (req, res) => {
  const { client_id, products } = req.body || {};
  if (!client_id || !Array.isArray(products)) return res.status(400).json({ error: '缺少 client_id 或 products' });

  for (const p of products) {
    if (!p.sku || !p.name) return res.status(400).json({ error: '每個商品需要 sku 和 name' });
  }

  try {
    setProductCatalog(parseInt(client_id, 10), products);
    res.json({ ok: true, count: products.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin: POST /api/checkout/catalog/import-csv ───
// body: { client_id, csv } — csv 是純文字，格式: sku,name,price,image_url,description
router.post('/checkout/catalog/import-csv', requireAdmin, (req, res) => {
  const { client_id, csv } = req.body || {};
  if (!client_id || !csv) return res.status(400).json({ error: '缺少 client_id 或 csv' });

  const lines = csv.trim().split('\n');
  const products = [];
  const errors = [];

  // 跳過 header 行（若有）
  const startLine = lines[0]?.toLowerCase().includes('sku') ? 1 : 0;

  for (let i = startLine; i < lines.length; i++) {
    const parts = lines[i].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    const [sku, name, price, image_url, description] = parts;
    if (!sku || !name) { errors.push(`第 ${i + 1} 行：缺少 sku 或 name`); continue; }
    products.push({
      sku,
      name,
      price: price ? parseFloat(price) : null,
      image_url: image_url || null,
      description: description || null,
    });
  }

  if (products.length === 0) return res.status(400).json({ error: 'CSV 無有效資料', errors });

  try {
    setProductCatalog(parseInt(client_id, 10), products);
    res.json({ ok: true, imported: products.length, errors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
