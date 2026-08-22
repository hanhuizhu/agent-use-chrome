/**
 * 截图数据处理
 *
 * 扩展回传的是 data:image/png;base64,... 的可视区截图。
 * 这里把 data URL 拆成 MCP image block 需要的 base64 + mimeType。
 * 注意：坐标系一致性由扩展侧保证（快照几何与截图都换算到 CSS 像素），
 * bridge 不做像素级缩放，避免引入二次误差。
 */

export interface ImagePayload {
  base64: string;
  mimeType: string;
}

/** 从 data URL 解析出 base64 与 mimeType */
export function parseDataUrl(dataUrl: string): ImagePayload {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) {
    throw new Error('截图数据格式非法（期望 data:*;base64,...）');
  }
  return { mimeType: match[1], base64: match[2] };
}
