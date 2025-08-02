export function log(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

export function logError(error, context = '') {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ERROR ${context}:`, error);
}
