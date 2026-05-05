/**
 * normalize.js
 * 將 LINE / FB Messenger / Instagram DM webhook payload 轉換成系統內部統一格式
 *
 * 內部訊息格式：
 * {
 *   channel: 'line' | 'fb' | 'ig',
 *   channelUserId: string,
 *   channelDisplayName: string | null,
 *   channelAvatarUrl: string | null,
 *   externalMessageId: string | null,
 *   contentType: 'text' | 'image' | 'audio' | 'video' | 'file' | 'sticker' | 'story_mention' | 'story_reply' | 'reaction',
 *   content: string | null,
 *   mediaUrl: string | null,
 *   metadata: object,
 *   timestamp: number,  // ms epoch
 * }
 */

export const normalizeLine = (event) => {
  const source = event.source || {};
  const msg = event.message || {};

  const typeMap = {
    text:     'text',
    image:    'image',
    audio:    'audio',
    video:    'video',
    file:     'file',
    sticker:  'sticker',
    location: 'location',
  };

  // 非 message event（follow/unfollow/postback 等）不含 message 欄位
  const contentType = typeMap[msg.type] || 'text';

  // 文字內容：text event 直接取，其他類型組織描述
  let content = null;
  if (msg.type === 'text') {
    content = msg.text || null;
  } else if (msg.type === 'sticker') {
    content = `[貼圖] packageId=${msg.packageId} stickerId=${msg.stickerId}`;
  } else if (msg.type === 'location') {
    content = msg.address ? `[位置] ${msg.address}` : '[位置分享]';
  } else if (msg.type) {
    // image / audio / video / file → 留 content=null，media_url 另外撈
    content = null;
  }

  return {
    channel: 'line',
    external_user_id: source.userId || null,
    external_message_id: msg.id || null,
    reply_token: event.replyToken || null,
    content,
    content_type: contentType,
    media_url: null,  // 媒體需要用 access token 另外下載（後續功能）
    timestamp: event.timestamp || Date.now(),
    // 舊欄位保留相容性
    channelUserId: source.userId || null,
    channelDisplayName: null,
    channelAvatarUrl: null,
    externalMessageId: msg.id || null,
    contentType,
    mediaUrl: null,
    metadata: { raw: event },
  };
};

export const normalizeFb = (messagingEntry) => {
  // TODO: 等 FB token 進來再實作完整解析
  // FB Messenger webhook entry 結構參考：
  // https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messages
  const msg = messagingEntry.message || {};
  const senderId = messagingEntry.sender?.id || null;

  let contentType = 'text';
  let content = null;
  let mediaUrl = null;

  if (msg.text) {
    content = msg.text;
    contentType = 'text';
  } else if (msg.attachments?.length) {
    const att = msg.attachments[0];
    const typeMap = { image: 'image', audio: 'audio', video: 'video', file: 'file' };
    contentType = typeMap[att.type] || 'file';
    mediaUrl = att.payload?.url || null;
  }

  return {
    channel: 'fb',
    channelUserId: senderId,
    channelDisplayName: null,  // FB 需要另外打 Graph API 取得
    channelAvatarUrl: null,
    externalMessageId: msg.mid || null,
    contentType,
    content,
    mediaUrl,
    metadata: { raw: messagingEntry },
    timestamp: messagingEntry.timestamp || Date.now(),
  };
};

/**
 * 解析 IG DM webhook payload
 *
 * IG payload 結構跟 FB Messenger 幾乎一樣（都是 entry.messaging[]），但：
 * - sender.id 是 IG-scoped PSID（不同於 FB PSID namespace）
 * - 多了 story_mention、story_reply、reaction 等特殊類型
 *
 * @param {object} messagingEntry - entry.messaging[i]（單則事件）
 * @returns {object} 內部統一格式
 *
 * TODO: 等 IG token 進來再實作完整解析（media_url 需要 token 才能下載）
 */
export const normalizeIg = (messagingEntry) => {
  const msg = messagingEntry.message || {};
  const senderId = messagingEntry.sender?.id || null;

  let contentType = 'text';
  let content = null;
  let mediaUrl = null;

  if (msg.text) {
    // 一般文字訊息
    content = msg.text;
    contentType = 'text';
  } else if (msg.attachments?.length) {
    // 圖片、影片、音檔等附件
    const att = msg.attachments[0];
    const typeMap = { image: 'image', audio: 'audio', video: 'video', file: 'file' };
    contentType = typeMap[att.type] || 'file';
    mediaUrl = att.payload?.url || null;
  } else if (messagingEntry.reaction) {
    // 訊息回應（reaction）
    contentType = 'reaction';
    content = messagingEntry.reaction.emoji || null;
  } else if (msg.story_mention) {
    // 限時動態提及
    contentType = 'story_mention';
    mediaUrl = msg.story_mention.url || null;
  } else if (msg.reply_to?.story) {
    // 限時動態回覆
    contentType = 'story_reply';
    content = msg.text || null;
    mediaUrl = msg.reply_to.story.url || null;
  }

  return {
    channel: 'ig',
    channelUserId: senderId,
    channelDisplayName: null,  // IG 需要另外打 Graph API 取得
    channelAvatarUrl: null,
    externalMessageId: msg.mid || null,
    contentType,
    content,
    mediaUrl,
    metadata: { raw: messagingEntry },
    timestamp: messagingEntry.timestamp || Date.now(),
  };
};
