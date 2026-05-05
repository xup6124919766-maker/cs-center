/**
 * transcribe.js
 * 透過 OpenAI Whisper API 將音訊 buffer 轉成文字
 *
 * 零依賴（FormData / Blob / fetch 均為 Node 18+ 內建）
 */

import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'transcribe' });

/**
 * 將音訊 buffer 送 Whisper API 取得逐字稿
 * @param {Buffer} audioBuffer - 音訊二進位資料
 * @param {string} [mimeType='audio/m4a'] - MIME 類型
 * @returns {Promise<{ ok: boolean, text?: string, error?: string }>}
 */
export const transcribeAudio = async (audioBuffer, mimeType = 'audio/m4a') => {
  if (!process.env.OPENAI_API_KEY) {
    log.warn('OPENAI_API_KEY 未設，跳過語音轉文字');
    return { ok: false, error: 'OPENAI_API_KEY 未設' };
  }

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType }), 'audio.m4a');
  form.append('model', 'whisper-1');
  form.append('language', 'zh');
  form.append('response_format', 'json');

  const start = Date.now();

  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });

    const duration = Date.now() - start;

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log.error({ status: res.status, duration_ms: duration, err: errText }, 'Whisper API 錯誤');
      return { ok: false, error: `Whisper API 錯誤: ${res.status} ${errText}` };
    }

    const data = await res.json();
    const text = (data.text || '').trim();
    log.info({ duration_ms: duration, text_len: text.length }, 'Whisper 轉文字完成');

    return { ok: true, text };
  } catch (e) {
    log.error({ err: e.message }, 'Whisper fetch 失敗');
    return { ok: false, error: e.message };
  }
};
