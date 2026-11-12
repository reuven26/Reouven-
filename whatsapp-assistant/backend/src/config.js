const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const digits = (s) => String(s || '').replace(/\D/g, '');

const provider = env('LLM_PROVIDER', 'groq').toLowerCase();
const PROVIDERS = {
  groq: { base: 'https://api.groq.com/openai/v1', key: env('GROQ_API_KEY'), llm: 'llama-3.3-70b-versatile', stt: 'whisper-large-v3-turbo' },
  openai: { base: 'https://api.openai.com/v1', key: env('OPENAI_API_KEY'), llm: 'gpt-4o-mini', stt: 'whisper-1' },
  anthropic: { base: 'https://api.anthropic.com/v1', key: env('ANTHROPIC_API_KEY'), llm: 'claude-haiku-5-5' },
};
const sttProvider = env('TRANSCRIPTION_PROVIDER', provider === 'anthropic' ? (PROVIDERS.groq.key ? 'groq' : 'openai') : provider).toLowerCase();

export const config = {
  port: Number(env('PORT', '4000')),
  dataDir: env('DATA_DIR', './data'),
  allowedPhone: digits(env('ALLOWED_PHONE_NUMBER')),
  timezone: env('TIMEZONE', 'UTC'),
  defaultTime: env('DEFAULT_REMINDER_TIME', '09:00'),
  briefingTime: env('DAILY_BRIEFING_TIME'),
  openwa: {
    url: env('OPENWA_URL', 'http://openwa:2785').replace(/\/$/, ''),
    apiKey: env('OPENWA_API_KEY'),
    sessionName: env('OPENWA_SESSION_NAME', 'assistant'),
    webhookSecret: env('WEBHOOK_SECRET'),
    callbackUrl: env('WEBHOOK_CALLBACK_URL', 'http://backend:4000/webhooks/openwa'),
  },
  llm: {
    provider,
    baseUrl: env('LLM_BASE_URL', PROVIDERS[provider]?.base || '').replace(/\/$/, ''),
    apiKey: PROVIDERS[provider]?.key || '',
    model: env('LLM_MODEL', PROVIDERS[provider]?.llm || ''),
    custom: !!env('LLM_BASE_URL'),
  },
  stt: {
    provider: sttProvider,
    baseUrl: PROVIDERS[sttProvider]?.base || '',
    apiKey: PROVIDERS[sttProvider]?.key || '',
    model: env('TRANSCRIPTION_MODEL', PROVIDERS[sttProvider]?.stt || ''),
  },
  google: {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    refreshToken: env('GOOGLE_REFRESH_TOKEN'),
    calendarId: env('GOOGLE_CALENDAR_ID', 'primary'),
  },
};
config.google.enabled = !!(config.google.clientId && config.google.clientSecret && config.google.refreshToken);
config.llm.ready = !!(config.llm.apiKey || config.llm.custom) && !!PROVIDERS[provider];
config.stt.ready = !!config.stt.apiKey && !!config.stt.model;

export function validateConfig() {
  const errors = [];
  if (!/^\d{8,15}$/.test(config.allowedPhone)) errors.push('ALLOWED_PHONE_NUMBER doit contenir 8 à 15 chiffres (format international sans +).');
  if (config.openwa.apiKey.length < 32) errors.push('OPENWA_API_KEY doit faire au moins 32 caractères (lancez ./setup.sh).');
  if (config.openwa.webhookSecret.length < 16) errors.push('WEBHOOK_SECRET doit faire au moins 16 caractères (lancez ./setup.sh).');
  try { new Intl.DateTimeFormat('fr-FR', { timeZone: config.timezone }); } catch { errors.push(`TIMEZONE invalide : ${config.timezone}`); }
  if (!PROVIDERS[provider]) errors.push(`LLM_PROVIDER inconnu : ${provider} (groq | openai | anthropic).`);
  if (!/^\d{2}:\d{2}$/.test(config.defaultTime)) errors.push('DEFAULT_REMINDER_TIME doit être au format HH:mm.');
  return errors;
}
