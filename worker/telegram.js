export function api(token) {
  const base = `https://api.telegram.org/bot${token}`;
  return async (method, params = {}) => {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`Telegram API error [${method}]:`, data.description);
    }
    return data.result;
  };
}
