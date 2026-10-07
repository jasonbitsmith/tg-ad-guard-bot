// Admin panel login rate limiting and sessions.
// Methods are copied onto GuardState.prototype in ../state.js.

export class AuthMethods {

  async loginAllowed(ip) {
    await this.schedule(Date.now() + 900000);
    // Use a fixed 15-minute window. This preserves brute-force protection while
    // ensuring an expired attempt bucket can never keep a user locked out.
    const key = `login:${ip}:${Math.floor(Date.now() / 900000)}`;
    const count = this.read(key, 0);
    return count < 10;
  }
  async recordLoginFailure(ip) { const key = `login:${ip}:${Math.floor(Date.now() / 900000)}`; this.write(key, this.read(key, 0) + 1, 900000); }
  createSession(hash, passwordHash) { this.write(`session:${hash}`, passwordHash, 8 * 3600000); }
  hasSession(hash, passwordHash) { return this.read(`session:${hash}`) === passwordHash; }
  deleteSession(hash) { this.remove(`session:${hash}`); }
}
