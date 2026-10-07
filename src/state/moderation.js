import { aiReviewCandidate } from '../ai-review.js';
// Message classification into action plans, commands and callbacks.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';
import { classify, normalize, parseCommand, validateWord } from '../filters.js';
import { sampleMatches } from '../samples.js';
import { DAY, ADMIN_STATUS, HELP, normalizeKnowledge } from './shared.js';

export class ModerationMethods {
  async plan(update) {
    const empty = { ops: [] };
    const msg = update.message || update.edited_message;
    if (!msg || !['group','supergroup'].includes(msg.chat?.type)) return empty;
    const tg = telegram(this.env.BOT_TOKEN);
    const chatId = msg.chat.id;
    this.write('chat', msg.chat);
    this.rememberMember(msg.from);
    for(const user of msg.new_chat_members||[])this.rememberMember(user);
    this.rememberMember(msg.reply_to_message?.from);
    if (msg.new_chat_members) {
      for (const member of msg.new_chat_members) this.write(`join:${member.id}`, Date.now(), DAY);
      const config = await this.config();
      const recentJoins = this.read('raid:joins', []).filter(at => at > Date.now() - 5 * 60000);
      for (const member of msg.new_chat_members) if (!member.is_bot) recentJoins.push(Date.now());
      this.write('raid:joins', recentJoins.slice(-100), 5 * 60000);
      const raidStarted = config.raidEnabled && recentJoins.length >= config.raidJoinLimit;
      if (raidStarted) this.write('raid:until', Date.now() + config.raidMinutes * 60000, config.raidMinutes * 60000);
      const raidActive = this.read('raid:until', 0) > Date.now();
      const names = msg.new_chat_members.filter(member => !member.is_bot).map(member => [member.first_name, member.last_name].filter(Boolean).join(' ') || '新成员');
      const message = [config.welcomeMessage && config.welcomeMessage.replaceAll('{name}', names.join('、')).replaceAll('{group}', msg.chat.title || ''), config.rulesMessage && `群规：${config.rulesMessage}`].filter(Boolean).join('\n\n').slice(0, 4000);
      const ops = message ? [{ method: 'sendMessage', params: { chat_id: chatId, text: message } }] : [];
      const started = [];
      for (const member of msg.new_chat_members) {
        const verification = await this.startVerification(member, msg, config, tg, raidActive && this.verificationMode(config) === 'off');
        if (!verification) continue;
        started.push(member.id);
        ops.push({ method: 'restrictChatMember', params: { chat_id: chatId, user_id: member.id, permissions: this.verificationPermissions(), use_independent_chat_permissions: true } });
        const replyMarkup = verification.mode === 'channel' ? { reply_markup: { inline_keyboard: [[{ text: '① 打开频道，点击加入', url: `https://t.me/${verification.channel.slice(1)}` }], [{ text: '② 已加入，完成验证', callback_data: `verify:channel:${member.id}` }]] } } : {};
        ops.push({ method: 'sendMessage', params: { chat_id: chatId, text: verification.text, ...replyMarkup }, verificationPromptFor: member.id });
      }
      return ops.length ? { ops, entry: { chatId, chatTitle: msg.chat.title || '', action: started.length ? 'welcome-and-verification-started' : 'welcome-and-rules', outcome: 'pending', userId: started.join(','), reasons: started.length ? [raidActive && this.verificationMode(config) === 'off' ? '反入群轰炸：临时算术验证已开启' : `${this.verificationMode(config)} 验证已开启`] : undefined } } : empty;
    }
    // Anonymous group admins and automatic linked-channel posts are trusted separately.
    if (msg.sender_chat?.id === chatId || msg.is_automatic_forward) return empty;
    if (!msg.sender_chat && (!msg.from || msg.from.is_bot)) return empty;
    const senderId = msg.sender_chat ? `channel:${msg.sender_chat.id}` : String(msg.from.id);
    const text = msg.text || msg.caption || '';
    if (!msg.sender_chat && text.startsWith('/')) {
      const me = await this.me(tg);
      const command = parseCommand(text, me.username || '');
      if (command) {
        // Editing an old command must not re-run a destructive operation.
        if (update.edited_message) return empty;
        if (command.command === 'spam' && await this.privileged(tg, chatId, msg.from.id)) return this.spamPlan(msg,tg);
        if (command.command === 'report') return this.reportPlan(msg, tg, command.arg);
        if (['start','help','status','addword','removeword','listwords','warnings','clearwarn','allow','unallow','unban','unmute','ban','kick'].includes(command.command) && await this.privileged(tg, chatId, msg.from.id)) return this.commandPlan(command, msg, tg);
        const note = this.findKnowledgeCommand(command.command, await this.config());
        if (note) return { ops: [{ method: 'sendMessage', params: { chat_id: chatId, text: note.response, reply_to_message_id: msg.message_id, allow_sending_without_reply: true, disable_web_page_preview: true } }], entry: { chatId, chatTitle: msg.chat.title || '', userId: msg.from.id, action: 'knowledge-command', outcome: 'pending', text: note.title, reasons: [`/${note.command}`] } };
        // Non-admin slash commands still pass through spam detection.
      }
    }
    let membership;
    if (!msg.sender_chat) {
      if (this.owners().includes(String(msg.from.id))) return empty;
      membership = await this.member(tg, chatId, msg.from.id);
      if (ADMIN_STATUS.includes(membership.status)) return empty;
    }
    const pendingVerification = !msg.sender_chat && this.verification(msg.from.id);
    if(pendingVerification && pendingVerification.expires<=Date.now())return {ops:[{method:'deleteMessage',params:{chat_id:chatId,message_id:msg.message_id}}]};
    if (pendingVerification?.mode === 'math') {
      if (String(msg.text || '').trim() === pendingVerification.answer) {
        this.clearVerification(msg.from.id);
        const restore = await this.restoreMember(chatId, msg.from.id, tg);
        const ops = [{ method: 'deleteMessage', params: { chat_id: chatId, message_id: msg.message_id } }];
        if (pendingVerification.prompt_message_id) ops.push({ method: 'deleteMessage', params: { chat_id: chatId, message_id: pendingVerification.prompt_message_id } });
        ops.push(restore, { method: 'sendMessage', params: { chat_id: chatId, text: '✅ 验证通过，已解除新成员限制。' } });
        return { ops, entry: { chatId, chatTitle: msg.chat.title || '', userId: msg.from.id, action: 'verification-passed', outcome: 'pending', reasons: ['算术验证'] } };
      }
      return { ops: [{ method: 'deleteMessage', params: { chat_id: chatId, message_id: msg.message_id } }], entry: { chatId, chatTitle: msg.chat.title || '', userId: msg.from.id, action: 'verification-answer-rejected', outcome: 'pending', reasons: ['算术答案不正确'] } };
    }
    if (this.read(`allow:${senderId}`) || this.read(`offence:${msg.message_id}`)) return empty;
    const policy = await this.config();
    const contentLock = this.contentLock(msg, policy.contentLocks);
    if (contentLock) {
      const entry = { chatId, chatTitle: msg.chat.title || '', userId: senderId, userName: msg.sender_chat?.title || [msg.from?.first_name,msg.from?.last_name].filter(Boolean).join(' '), messageId: msg.message_id, text: text.slice(0, 300), reasons: [`内容限制：${contentLock.label}`] };
      const ops = [{ method: 'deleteMessage', params: { chat_id: chatId, message_id: msg.message_id } }];
      if (contentLock.action === 'ban' && !msg.sender_chat) {
        ops.push({ method: 'banChatMember', params: { chat_id: chatId, user_id: msg.from.id, until_date: 0 } });
        const federationTargets = await this.env.GUARD_STATE.getByName('admin').federationTargets(chatId);
        // Linked groups are dispatched to independent durable jobs by runJob.
        return { ops, entry: { ...entry, action: federationTargets.length ? 'content-lock-delete-and-federated-permanent-ban' : 'content-lock-delete-and-permanent-ban', federationTargets } };
      }
      ops.push({ local: 'processed', messageId: msg.message_id });
      return { ops, entry: { ...entry, action: 'content-lock-delete' } };
    }
    this.observeTrials(msg);
    let reviewText=text;
    const joined = this.read(`join:${senderId}`, 0);
    const verdict = classify(msg, policy.keywords, joined > Date.now() - policy.newMemberMinutes * 60000, { allowlist: policy.domainAllowlist, denylist: policy.domainDenylist });
    // Only same-user, same-group text from the last three minutes. Never quoted reply text.
    const recent=this.read(`context:${senderId}`,[]).filter(x=>x.at>Date.now()-180000 && x.id!==msg.message_id).slice(-4);
    if(text) recent.push({id:msg.message_id,at:Date.now(),text:text.slice(0,800)});
    this.write(`context:${senderId}`,recent,180000);
    if(recent.length>1 && verdict.score<7) {
      const combined=classify({...msg,text:recent.map(x=>x.text).join(' ')},[],false,{allowlist:policy.domainAllowlist,denylist:policy.domainDenylist});
      if(combined.permanentBan && combined.score>=4) {
        Object.assign(verdict,combined); verdict.reasons.push('同一账号 3 分钟内分段广告');
        verdict.contextMessageIds=recent.map(x=>x.id);
      }
    }
    const linkQuarantine = policy.newMemberLinkGuard && joined > Date.now() - policy.newMemberLinkMinutes * 60000 && verdict.hasLink;
    const hasMedia = !!(msg.photo?.length || msg.video || msg.animation || msg.document || msg.audio || msg.voice || msg.video_note || msg.sticker);
    const mediaQuarantine = policy.newMemberMediaGuard && joined > Date.now() - policy.newMemberMediaMinutes * 60000 && hasMedia;
    if (linkQuarantine) { verdict.score = Math.max(4, verdict.score); verdict.reasons.push(`新成员链接隔离（入群 ${policy.newMemberLinkMinutes} 分钟内）`); }
    const sampleRules = await this.cachedSamples();
    const sampleHits = sampleMatches(msg, sampleRules);
    if (sampleHits.length) {
      verdict.score = Math.max(7, verdict.score);
      verdict.reasons.push(`样本库：${sampleHits.slice(0, 3).map(sample => sample.label || sample.value).join('、')}`);
    }
    if (!sampleHits.some(sample => sample.kind === 'photo')) {
      const ocrText = await this.ocr(msg, tg);
      if (ocrText) {
        const ocrMsg = { ...msg, text: [text, ocrText].filter(Boolean).join('\n') };
        this.observeTrials(ocrMsg);
        reviewText=[text,ocrText].filter(Boolean).join('\n');
        const ocrVerdict = classify(ocrMsg, policy.keywords, joined > Date.now() - policy.newMemberMinutes * 60000, { allowlist: policy.domainAllowlist, denylist: policy.domainDenylist });
        const ocrSampleHits = sampleMatches(ocrMsg, sampleRules, ocrText);
        if (ocrSampleHits.length) { ocrVerdict.sampleIds=ocrSampleHits.map(x=>x.id);ocrVerdict.score = Math.max(7, ocrVerdict.score); ocrVerdict.reasons.push(`OCR 样本库：${ocrSampleHits.slice(0, 3).map(sample => sample.label || sample.value).join('、')}`); }
        if (ocrVerdict.score > verdict.score) Object.assign(verdict, ocrVerdict);
      }
    }
    let samples = this.read(`flood:${senderId}`, []).filter(x => x.at > Date.now() - 60000 && x.id !== msg.message_id);
    const fingerprint = normalize(text) || msg.sticker?.file_unique_id || msg.photo?.at(-1)?.file_unique_id || msg.document?.file_unique_id || msg.video?.file_unique_id || '';
    if (fingerprint) samples.push({ id: msg.message_id, at: Date.now(), text: fingerprint });
    samples = samples.slice(-50);
    this.write(`flood:${senderId}`, samples, 120000);
    const repeat = fingerprint ? samples.filter(x => x.text === fingerprint).length : 0;
    if (repeat >= policy.repeatThreshold || samples.length >= policy.floodThreshold) {
      verdict.score = Math.max(4, verdict.score);
      verdict.reasons.push(repeat >= policy.repeatThreshold ? `60 秒内相同内容 ${repeat} 次（含交替刷屏）` : `60 秒内消息 ${samples.length} 条`);
    }
    // Coordinated spam often rotates accounts to evade per-sender flood limits.
    // Keep a short group-scoped fingerprint window only for substantial text.
    if (fingerprint.length >= 6) {
      const key = `groupflood:${fingerprint.slice(0, 160)}`;
      let groupSamples = this.read(key, []).filter(x => x.at > Date.now() - 10 * 60000 && x.id !== msg.message_id);
      groupSamples.push({ id: msg.message_id, at: Date.now(), senderId });
      groupSamples = groupSamples.slice(-50); this.write(key, groupSamples, 15 * 60000);
      if (new Set(groupSamples.map(x => x.senderId)).size >= 2) {
        verdict.score = Math.max(4, verdict.score);
        verdict.reasons.push('10 分钟内多个账号重复相同内容');
      }
    }
    let aiReview;
    if(policy.aiReviewEnabled&&aiReviewCandidate(reviewText,verdict)){
      aiReview=await this.reviewWithAi(msg,reviewText);
      if(aiReview.decision==='ad'){verdict.permanentBan=true;verdict.score=Math.max(7,verdict.score);verdict.reasons.push('AI 确认广告：'+aiReview.reason);}
      else if(aiReview.decision==='normal'){verdict.score=0;verdict.reasons=[];}
      else {return {ops:mediaQuarantine?[{method:'deleteMessage',params:{chat_id:chatId,message_id:msg.message_id}}]:[],entry:{chatId,chatTitle:msg.chat.title||'',userId:senderId,messageId:msg.message_id,text:text.slice(0,300),action:mediaQuarantine?'new-member-media-quarantine':'review',aiReview,reasons:[aiReview.reason],score:verdict.score}};}
    }
    const knowledge = this.findKnowledgeTrigger(text, policy);
    if (!verdict.score && !verdict.deleteOnKeyword && !mediaQuarantine && knowledge) {
      const cooldown = `knowledge:${senderId}:${knowledge.id}`;
      if (!this.read(cooldown)) {
        this.write(cooldown, true, 60000);
        return { ops: [{ method: 'sendMessage', params: { chat_id: chatId, text: knowledge.response, reply_to_message_id: msg.message_id, allow_sending_without_reply: true, disable_web_page_preview: true } }], entry: { chatId, chatTitle: msg.chat.title || '', userId: senderId, messageId: msg.message_id, action: 'knowledge-auto-reply', reasons: [knowledge.title], text: knowledge.response.slice(0, 120) } };
      }
    }
    if (!verdict.score && !verdict.deleteOnKeyword && !mediaQuarantine) return empty;
    const entry = { aiReview, sampleIds:[...new Set(verdict.sampleIds||sampleHits.map(x=>x.id))], chatId, chatTitle: msg.chat.title || '', userId: senderId, userName: msg.sender_chat?.title || [msg.from?.first_name,msg.from?.last_name].filter(Boolean).join(' '), messageId: msg.message_id, text: text.slice(0, 300), score: verdict.score, reasons: verdict.reasons, keywordHits: verdict.hits, domains: verdict.domains };
    if (mediaQuarantine && verdict.score < 4 && !verdict.deleteOnKeyword) return { ops: [{ method: 'deleteMessage', params: { chat_id: chatId, message_id: msg.message_id } }, { local: 'processed', messageId: msg.message_id }], entry: { ...entry, action: 'new-member-media-quarantine', reasons: [...entry.reasons, `新成员媒体隔离（入群 ${policy.newMemberMediaMinutes} 分钟内）`] } };
    if (verdict.score < 4 && !verdict.deleteOnKeyword) return { ops: [], entry: { ...entry, action: 'review' } };
    const ops = [...new Set(verdict.contextMessageIds || [msg.message_id])].map(id=>({method:'deleteMessage',params:{chat_id:chatId,message_id:id}}));
    if (msg.sender_chat) {
      ops.push({ local: 'processed', messageId: msg.message_id });
      return { ops, entry: { ...entry, action: 'delete-channel-message' } };
    }
    ops.push({ method: 'banChatMember', params: { chat_id: chatId, user_id: msg.from.id, until_date: 0 } });
    const federationTargets = await this.env.GUARD_STATE.getByName('admin').federationTargets(chatId);
    // Linked groups are dispatched to independent durable jobs by runJob.
    ops.push({ local: 'processed', messageId: msg.message_id });
    return { ops, entry: { ...entry, action: federationTargets.length ? 'delete-and-federated-permanent-ban' : 'delete-and-permanent-ban', federationTargets } };
  }

  contentLock(msg, locks = {}) {
    const active = type => locks?.[type]?.enabled === true ? locks[type] : null;
    const kinds = [
      ['invite', /(?:https?:\/\/)?t\.me\/(?:joinchat\/|\+)/i.test([msg.text, msg.caption, ...(msg.entities || []).map(item => item.url || '')].filter(Boolean).join(' ')), 'Telegram 群邀请链接'],
      ['forward', !!(msg.forward_origin || msg.forward_date || msg.forward_from || msg.forward_from_chat), '转发消息'],
      ['inline', !!msg.via_bot, '内联机器人消息'],
      ['link', (msg.entities || msg.caption_entities || []).some(item => item.type === 'url' || item.type === 'text_link') || /(?:https?:\/\/|www\.)/i.test(msg.text || msg.caption || ''), '网址链接'],
      ['photo', !!msg.photo?.length, '图片'],
      ['video', !!msg.video || !!msg.video_note, '视频'],
      ['gif', !!msg.animation, 'GIF 动图'],
      ['file', !!msg.document, '文件'],
      ['audio', !!msg.audio || !!msg.voice, '音频或语音'],
      ['sticker', !!msg.sticker, '贴纸'],
    ];
    for (const [type, matched, label] of kinds) { const lock = active(type); if (matched && lock) return { action: lock.action === 'ban' ? 'ban' : 'delete', label }; }
    return null;
  }

  findKnowledgeCommand(command, config) { return normalizeKnowledge(config.knowledgeBase).find(item => item.enabled && item.command === command); }
  findKnowledgeTrigger(text, config) {
    const body = normalize(text);
    if (!body || body.startsWith('/')) return null;
    return normalizeKnowledge(config.knowledgeBase).find(item => item.enabled && item.triggers.some(trigger => body.includes(normalize(trigger)))) || null;
  }

  async callbackPlan(callback) {
    const message = callback?.message;
    const match = /^verify:channel:(\d{1,16})$/.exec(String(callback?.data || ''));
    if (!match || !message?.chat || String(callback.from?.id) !== match[1]) return { ops: [{ method: 'answerCallbackQuery', params: { callback_query_id: callback.id, text: '验证请求无效。', show_alert: true } }] };
    const pending = this.verification(callback.from.id);
    if (!pending || pending.expires<=Date.now() || pending.mode !== 'channel' || !pending.channel) return { ops: [{ method: 'answerCallbackQuery', params: { callback_query_id: callback.id, text: '该验证已失效，请联系管理员。', show_alert: true } }] };
    const tg = telegram(this.env.BOT_TOKEN);
    const joined = await this.member(tg, pending.channel, callback.from.id).catch(() => null);
    if (!joined) return { ops: [{ method: 'answerCallbackQuery', params: { callback_query_id: callback.id, text: '暂时无法检查订阅状态，请稍后重试；若一直失败，请联系管理员检查频道权限。', show_alert: true } }] };
    if (['left', 'kicked'].includes(joined.status) || joined.status==='restricted' && joined.is_member!==true) return { ops: [{ method: 'answerCallbackQuery', params: { callback_query_id: callback.id, text: `还没有检测到订阅。请点击第一个按钮打开 ${pending.channel}，在频道底部点击“加入 / Join”，再返回本群点击第二个按钮。`, show_alert: true } }] };
    this.clearVerification(callback.from.id);
    const restore = await this.restoreMember(message.chat.id, callback.from.id, tg);
    return { ops: [{ method: 'answerCallbackQuery', params: { callback_query_id: callback.id, text: '验证通过，欢迎加入！' } }, restore, { method: 'deleteMessage', params: { chat_id: message.chat.id, message_id: message.message_id } }], entry: { chatId: message.chat.id, chatTitle: message.chat.title || '', userId: callback.from.id, action: 'verification-passed', outcome: 'pending', reasons: [`频道验证：${pending.channel}`] } };
  }

  async spamPlan(msg,tg) {
    const target=msg.reply_to_message;
    if (!target?.from?.id || target.from.is_bot || target.sender_chat || target.chat?.id && target.chat.id!==msg.chat.id) throw new Error('请回复普通用户的广告消息发送 /spam');
    if (!this.owners().includes(String(msg.from.id))) {
      const actor=await this.member(tg,msg.chat.id,msg.from.id);
      if(actor.status!=='creator' && !actor.can_restrict_members) throw new Error('缺少封禁成员权限');
    }
    const member=await this.member(tg,msg.chat.id,target.from.id);
    if(ADMIN_STATUS.includes(member.status) || this.owners().includes(String(target.from.id))) throw new Error('不能处理管理员或机器人所有者');
    const sample=target.photo?.at(-1)?.file_unique_id ? {kind:'photo',value:target.photo.at(-1).file_unique_id} : {kind:'text',value:(target.text || target.caption || '').slice(0,500)};
    const ops=[{method:'deleteMessage',params:{chat_id:msg.chat.id,message_id:target.message_id}}, {method:'banChatMember',params:{chat_id:msg.chat.id,user_id:target.from.id,until_date:0}}];
    if(sample.value) ops.push({local:'sample',sample:{...sample,label:'管理员 /spam 待审核',pending:true}});
    ops.push({method:'deleteMessage',params:{chat_id:msg.chat.id,message_id:msg.message_id}});
    return {ops,entry:{chatId:msg.chat.id,actorId:msg.from.id,userId:target.from.id,messageId:target.message_id,action:'spam-delete-and-permanent-ban',text:(target.text||target.caption||'').slice(0,300),reasons:['管理员确认广告；样本待审核']}};
  }

  async reportPlan(msg, tg, reason = '') {
    const target = msg.reply_to_message;
    const reply = text => ({ ops: [{ method: 'deleteMessage', params: { chat_id: msg.chat.id, message_id: msg.message_id } }, { method: 'sendMessage', params: { chat_id: msg.chat.id, text } }], entry: { chatId: msg.chat.id, chatTitle: msg.chat.title || '', actorId: msg.from.id, action: 'user-report', outcome: 'pending' } });
    if (!target?.from?.id || target.from.is_bot || target.sender_chat) return reply('请回复需要举报的普通用户消息后发送 /report。');
    if (target.from.id === msg.from.id) return reply('不能举报自己的消息。');
    const member = await this.member(tg, msg.chat.id, target.from.id);
    if (ADMIN_STATUS.includes(member.status) || this.owners().includes(String(target.from.id))) return reply('不能举报群管理员或机器人所有者。');
    return { ops: [{ method: 'deleteMessage', params: { chat_id: msg.chat.id, message_id: msg.message_id } }, { method: 'sendMessage', params: { chat_id: msg.chat.id, text: '✅ 举报已记录，管理员会在后台处理。' } }], entry: { chatId: msg.chat.id, chatTitle: msg.chat.title || '', actorId: msg.from.id, userId: target.from.id, messageId: target.message_id, action: 'user-report', outcome: 'success', text: (target.text || target.caption || '').slice(0, 300), reasons: [reason.slice(0, 100) || '成员举报'] } };
  }

  async commandPlan({ command, arg }, msg, tg) {
    const chatId = msg.chat.id;
    const entry = { chatId, chatTitle: msg.chat.title || '', actorId: msg.from.id, action: command, text: arg.slice(0, 100), reasons: ['管理员操作'] };
    const reply = text => ({ ops: [{ method: 'sendMessage', params: { chat_id: chatId, text: text.slice(0, 4000) } }], entry });
    if (['ban','kick','unban','unmute'].includes(command) && !this.owners().includes(String(msg.from.id))) {
      const actor = await this.member(tg, chatId, msg.from.id);
      if (actor.status !== 'creator' && !actor.can_restrict_members) return reply('你没有限制群成员的管理权限，未执行该操作。');
    }
    if (command === 'start' || command === 'help') return reply(HELP);
    if (command === 'status') {
      const me = await this.me(tg);
      const member = await this.member(tg, chatId, me.id);
      const policy = await this.config();
      return reply(`运行正常 · v2\n广告命中：删除消息并永久封禁账号，不发送或累计警告\n删消息权限：${member.can_delete_messages ? '有' : '无'}\n限制成员权限：${member.can_restrict_members ? '有' : '无'}\n群类型：${msg.chat.type}\n词库：本群独立 ${policy.keywords.length} 个词\n群内自动通知：关闭，处理结果在后台查看`);
    }
    if (['addword','removeword','listwords'].includes(command)) {
      const config = await this.config();
      if (command === 'listwords') return reply(`本群黑名单关键词（命中即删消息）：\n${config.keywords.join('、')}`);
      let word;
      try { word = validateWord(arg); } catch (e) { return reply(e.message); }
      if (command === 'addword') {
        if (config.keywords.length >= 500) return reply('词库已达 500 个，请先清理。');
        if (!config.keywords.includes(word)) config.keywords.push(word);
      } else config.keywords = config.keywords.filter(w => w !== word);
      this.saveConfig(config, `群内${command.command}`);
      return reply(`已${command === 'addword' ? '添加' : '移除'}本群关键词：${word}`);
    }
    const target = /^\d{1,16}$/.test(arg) ? Number(arg) : msg.reply_to_message?.from?.id;
    if (!target || !Number.isSafeInteger(target) || (msg.reply_to_message?.sender_chat && !arg)) return reply('请回复普通用户的消息，或在指令后填写数字用户 ID。频道身份请由管理员在 Telegram 中处理。');
    entry.userId = target;
    if (command === 'warnings') return reply(`用户 ${target}：${this.read(`warn:${target}`, 0)} 次警告；白名单：${this.read(`allow:${target}`) ? '是' : '否'}`);
    if (['clearwarn','allow','unallow'].includes(command)) {
      if (command === 'clearwarn' || command === 'allow') { this.remove(`warn:${target}`); this.remove(`flood:${target}`); }
      if (command === 'allow') this.write(`allow:${target}`, true);
      if (command === 'unallow') this.remove(`allow:${target}`);
      return reply(`已执行 ${command}：${target}。白名单不自动解除现有限制；需要时再使用 /unmute 或 /unban。`);
    }
    const member = await this.member(tg, chatId, target);
    if (ADMIN_STATUS.includes(member.status) || this.owners().includes(String(target)) || target === (await this.me(tg)).id) return reply('不能对群管理员、机器人所有者或机器人自身执行处罚。');
    const params = { chat_id: chatId, user_id: target };
    let ops = [];
    if (command === 'ban' || command === 'kick') {
      ops.push({ method: 'banChatMember', params });
      if (command === 'kick') ops.push({ method: 'unbanChatMember', params: { ...params, only_if_banned: true } });
    }
    if (command === 'unban') ops = [{ method: 'unbanChatMember', params: { ...params, only_if_banned: true } }];
    if (command === 'unmute') {
      if (msg.chat.type !== 'supergroup') return reply('普通群不支持禁言权限操作。');
      if (member.status === 'kicked') return reply('该用户已被封禁，请先使用 /unban。');
      const chat = await tg('getChat', { chat_id: chatId });
      if (!chat.permissions) return reply('无法读取群默认权限，未修改用户权限。');
      ops = [{ method: 'restrictChatMember', params: { ...params, permissions: chat.permissions, use_independent_chat_permissions: true } }];
    }
    ops.push({ method: 'sendMessage', params: { chat_id: chatId, text: `已成功执行 /${command}：${target}` } });
    return { ops, entry };
  }
}
