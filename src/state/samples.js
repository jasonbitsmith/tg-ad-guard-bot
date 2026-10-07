// Spam sample library (global) and the per-group sample cache.
// Methods are copied onto GuardState.prototype in ../state.js.
import { normalize } from '../filters.js';
import { sampleMatches, validateSample } from '../samples.js';
import { DAY } from './shared.js';

export class SamplesMethods {

  listSamples() { return this.sql.exec('SELECT id,kind,value,label,created FROM samples ORDER BY id DESC LIMIT 300').toArray().map(row => ({ ...row, status: row.kind==='text' && [...row.value].length<6 ? 'disabled' : this.read(`sample-status:${row.id}`, 'active') })); }
  listReviewExamples(){return this.sql.exec("SELECT value FROM records WHERE key LIKE 'review-example:%' AND expires>? ORDER BY rowid DESC LIMIT 500",Date.now()).toArray().map(x=>JSON.parse(x.value));}
  editReviewExample(action,body){
    if(action==='remove'){this.sql.exec("DELETE FROM records WHERE key LIKE 'sample-preview:%'");this.remove('review-example:'+String(body.id));return this.listReviewExamples();}
    if(!['normal','advertisement'].includes(body.verdict) || body.confirmed!==true)throw new Error('必须人工确认案例分类');
    if(typeof body.text!=='string' || body.text.length>4000)throw new Error('案例内容须为 6–4000 个字符');
    const text=body.text.normalize('NFKC').trim().slice(0,4000)
      .replace(/https?:\/\/[^\s]+/gi,value=>{try{return new URL(value).origin;}catch{return '[链接]';}})
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱]')
      .replace(/@[a-zA-Z0-9_]{5,}/g,'@user')
      .replace(/\d{7,}/g,'[号码]');
    if(text.length<6)throw new Error('案例至少 6 个字符');
    this.sql.exec("DELETE FROM records WHERE key LIKE 'sample-preview:%'");
    const id=crypto.randomUUID();this.write('review-example:'+id,{id,text,verdict:body.verdict,created:new Date().toISOString()},90*DAY);
    const rows=this.sql.exec("SELECT key FROM records WHERE key LIKE 'review-example:%' ORDER BY rowid DESC LIMIT -1 OFFSET 500").toArray();for(const row of rows)this.remove(row.key);
    return this.listReviewExamples();
  }
  previewSample(id) {
    const sample=this.listSamples().find(x=>x.id===Number(id));if(!sample)throw new Error('样本不存在');
    let reason='';try{validateSample(sample.kind,sample.value,sample.label);}catch(error){reason=error.message;}
    const examples=['有没有服务器推荐？香港节点怎么样？','这个服务器怎么买，有没有官网吗？','我今天赚了钱，准备续费 VPS。','可以私聊发一下官网链接吗？','不要相信日结兼职、稳赚和刷单广告。','手机拍照怎么导出？','频道订阅之后还是无法验证。','感谢分享，官网价格和配置在哪里看？'];
    const matches=examples.filter(text=>sampleMatches({text},[{...sample,status:'active'}]).length);
    const token=crypto.randomUUID();this.write(`sample-preview:${sample.id}`,token,15*60000);
    const cases=this.listReviewExamples().map(item=>({...item,matched:sampleMatches({text:item.text},[{...sample,status:'active'}]).length>0}));
    return {eligible:!reason,reason,examples,matches,cases,previewToken:token};
  }
  testSample(body) { const sample = validateSample(body.kind, body.value, body.label || ''); return { matched: sampleMatches({text:String(body.text || '').slice(0,4000)}, [sample]).length > 0 }; }
  // Groups cache the sample list (see cachedSamples); tell them to drop it so
  // an edit takes effect on the next message rather than after the cache ages out.
  async broadcastSamplesChanged() {
    await Promise.allSettled(this.listChats().map(chat => this.env.GUARD_STATE.getByName('chat:' + chat.id).invalidateSamples()));
  }
  async editSample(action, body) {
    const result = await this.applySampleEdit(action, body);
    // New samples start as pending and do not match until activated.
    if (action !== 'add') await this.broadcastSamplesChanged();
    return result;
  }
  async applySampleEdit(action, body) {
    if (action === 'remove') { this.sql.exec('DELETE FROM samples WHERE id=?', Number(body.id)); return this.listSamples(); }
    if (action === 'activate' || action === 'disable') {
      if (!this.sql.exec('SELECT id FROM samples WHERE id=?', Number(body.id)).toArray().length) throw new Error('样本不存在');
      if(action==='activate'){const sample=this.listSamples().find(x=>x.id===Number(body.id));validateSample(sample.kind,sample.value,sample.label);if(!body.previewToken || this.read(`sample-preview:${sample.id}`)!==body.previewToken)throw new Error('请先预览样本命中结果，再启用');this.remove(`sample-preview:${sample.id}`);}
      this.write(`sample-status:${Number(body.id)}`, action === 'activate' ? 'active' : 'disabled');
      this.log({action:'sample-'+action,actorId:'web-admin',outcome:'success',sampleId:Number(body.id)}); return this.listSamples();
    }
    const sample = validateSample(body.kind, body.value, body.label,body.pending===true);
    const existing=this.sql.exec('SELECT id FROM samples WHERE kind=? AND value=?',sample.kind,sample.value).toArray()[0];
    this.sql.exec('INSERT OR IGNORE INTO samples(kind,value,label,created) VALUES (?,?,?,?)', sample.kind, sample.value, sample.label, Date.now());
    const row=this.sql.exec('SELECT id FROM samples WHERE kind=? AND value=?',sample.kind,sample.value).toArray()[0];
    if (!existing) this.write(`sample-status:${row.id}`, 'pending');
    this.log({ action: 'sample-add', actorId: 'web-admin', sample: sample.kind, text: sample.value, outcome: 'success' });
    return this.listSamples();
  }
  async cachedSamples() {
    if (this.samplesCache && this.samplesCache.at > Date.now() - 60000) return this.samplesCache.rules;
    const rules = await this.env.GUARD_STATE.getByName('admin').listSamples();
    this.samplesCache = { at: Date.now(), rules };
    return rules;
  }
  invalidateSamples() { this.samplesCache = null; }
}
