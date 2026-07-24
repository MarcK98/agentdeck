const ts = () => new Date().toISOString();

export const log = {
  info: (...a) => console.log(`[${ts()}]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] WARN`, ...a),
  error: (...a) => console.error(`[${ts()}] ERROR`, ...a),
};
