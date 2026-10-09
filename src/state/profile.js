// The bot's display name, profile photo and about text. Telegram lets a bot change both
// itself, so the owner doesn't have to do it by hand in @BotFather. Runs on
// the global admin object from the cron; each change is applied once.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram, telegramUpload } from '../telegram.js';
import { AVATAR_ID, AVATAR_BASE64 } from '../assets/bot-avatar.js';

export const BOT_NAME = 'Jason Guard Bot';
// Shown on the bot's profile. The longer description (shown when someone
// opens a chat with the bot) also keeps the /start appeal hint.
export const BOT_ABOUT = '自动群管理机器人｜负责广告拦截、入群验证与群秩序维护。误封请联系管理员复核。';
const BOT_DESCRIPTION = `${BOT_ABOUT}\n\n被误封了？私聊我发送 /start，可以查看封禁原因并提交申诉。`;

const avatarBytes = () => Uint8Array.from(atob(AVATAR_BASE64), c => c.charCodeAt(0));

export class ProfileMethods {
  async ensureBotProfile() {
    const nameKey = `bot-profile:name:${BOT_NAME}`, photoKey = `bot-profile:photo:${AVATAR_ID}`, aboutKey = `bot-profile:about:${BOT_DESCRIPTION}`;
    if (this.read(nameKey) && this.read(photoKey) && this.read(aboutKey)) return false;
    // Retry at most hourly after a failure; a new target retries straight away.
    const checkedKey = `bot-profile:checked:${nameKey}|${photoKey}|${aboutKey}`;
    if (this.read(checkedKey)) return false;
    this.write(checkedKey, true, 3600000);
    if (!this.read(nameKey)) {
      const tg = telegram(this.env.BOT_TOKEN);
      if ((await tg('getMyName'))?.name !== BOT_NAME) await tg('setMyName', { name: BOT_NAME });
      this.write(nameKey, true);
      this.log({ action: 'bot-name', outcome: 'success' });
    }
    if (!this.read(aboutKey)) {
      const tg = telegram(this.env.BOT_TOKEN);
      await tg('setMyShortDescription', { short_description: BOT_ABOUT });
      await tg('setMyDescription', { description: BOT_DESCRIPTION });
      this.write(aboutKey, true);
      this.log({ action: 'bot-about', outcome: 'success' });
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
