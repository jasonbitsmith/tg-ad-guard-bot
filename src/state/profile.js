// The bot's display name and profile photo. Telegram lets a bot change both
// itself, so the owner doesn't have to do it by hand in @BotFather. Runs on
// the global admin object from the cron; each change is applied once.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram, telegramUpload } from '../telegram.js';
import { AVATAR_ID, AVATAR_BASE64 } from '../assets/bot-avatar.js';

export const BOT_NAME = 'Jason Guard Bot';

const avatarBytes = () => Uint8Array.from(atob(AVATAR_BASE64), c => c.charCodeAt(0));

export class ProfileMethods {
  async ensureBotProfile() {
    const nameKey = `bot-profile:name:${BOT_NAME}`, photoKey = `bot-profile:photo:${AVATAR_ID}`;
    if (this.read(nameKey) && this.read(photoKey)) return false;
    if (this.read('bot-profile:checked')) return false;
    this.write('bot-profile:checked', true, 3600000);
    if (!this.read(nameKey)) {
      const tg = telegram(this.env.BOT_TOKEN);
      if ((await tg('getMyName'))?.name !== BOT_NAME) await tg('setMyName', { name: BOT_NAME });
      this.write(nameKey, true);
      this.log({ action: 'bot-name', outcome: 'success' });
    }
    if (!this.read(photoKey)) {
      await telegramUpload(this.env.BOT_TOKEN, 'setMyProfilePhoto', { photo: { type: 'static', photo: 'attach://avatar' } },
        { field: 'avatar', bytes: avatarBytes(), name: 'avatar.jpg', mime: 'image/jpeg' });
      this.write(photoKey, true);
      this.log({ action: 'bot-photo', outcome: 'success' });
    }
    return true;
  }
}
