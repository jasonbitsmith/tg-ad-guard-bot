import { DEFAULT_POLICY, CONTENT_LOCK_TYPES, validateWord, normalizeDomain } from './filters.js';
import { validateSample } from './samples.js';

export function validateBackup(input) {
  if(new TextEncoder().encode(JSON.stringify(input)).length>512000)throw Error('备份不能超过 500 KB');
  if(!input || input.schema!==1 || !Array.isArray(input.groups) || !Array.isArray(input.samples) || !Array.isArray(input.federation))throw Error('备份格式或版本无效');
  if(Object.keys(input).some(key=>!['schema','created','groups','samples','federation'].includes(key)))throw Error('备份包含不支持的字段');
  if(input.groups.length>100 || input.samples.length>1000)throw Error('备份超过 100 群或 1000 样本的上限');
  const ids=new Set();
  const groups=input.groups.map(group=>{
    const id=String(group.id);if(!/^-[0-9]+$/.test(id) || !Number.isSafeInteger(Number(id)) || ids.has(id))throw Error('群 ID 无效或重复');ids.add(id);
    if(typeof group.title!=='string' || group.title.length>200)throw Error('群名称无效');
    return {id,title:group.title,config:validateConfig(group.config)};
  });
  const samples=input.samples.map(sample=>{if(!['active','pending','disabled'].includes(sample.status))throw Error('样本状态无效');return {...validateSample(sample.kind,sample.value,sample.label||'',sample.status!=='active'),status:sample.status};});
  if(new Set(samples.map(x=>JSON.stringify([x.kind,x.value]))).size!==samples.length)throw Error('样本重复');
  const federation=input.federation.map(String);if(federation.length>100 || new Set(federation).size!==federation.length || federation.some(id=>!ids.has(id)))throw Error('联防群必须存在于备份且不能重复');
  return {schema:1,created:String(input.created||''),groups,samples,federation};
}
export function validateConfig(raw){
  if(!raw || typeof raw!=='object' || Array.isArray(raw))throw Error('群配置无效');
  if(Object.keys(raw).some(key=>!Object.hasOwn(DEFAULT_POLICY,key) && key!=='keywords'))throw Error('群配置含未知字段');
  const config={...DEFAULT_POLICY,...raw};
  for(const [key,value] of Object.entries(DEFAULT_POLICY)){
    if(['contentLocks','knowledgeBase','domainAllowlist','domainDenylist'].includes(key))continue;
    if(typeof config[key]!==typeof value)throw Error('配置类型无效：'+key);
    if(typeof value==='number' && (!Number.isInteger(config[key]) || config[key]<1 || config[key]>1440))throw Error('配置数值无效：'+key);
  }
  for(const key of ['newMemberLinkMinutes','newMemberMediaMinutes'])if(config[key]>1440)throw Error('新人隔离时限无效');
  for(const key of ['welcomeMessage','rulesMessage'])if(config[key].length>2500)throw Error('欢迎语或群规过长');
  if(!Array.isArray(raw.keywords) || raw.keywords.length>500)throw Error('关键词数量无效');config.keywords=[...new Set(raw.keywords.map(validateWord))];
  for(const key of ['domainAllowlist','domainDenylist']){if(!Array.isArray(config[key]) || config[key].length>300)throw Error('域名名单无效');config[key]=[...new Set(config[key].map(normalizeDomain))];}
  if(!['off','math','button','channel'].includes(config.verificationMode) || !['ban','kick'].includes(config.verificationTimeoutAction) || config.verificationMinutes>60 || (config.verificationMode==='channel' && !/^@[a-zA-Z0-9_]{5,}$/.test(config.verificationChannel)))throw Error('验证配置无效');
  if(config.raidJoinLimit<2 || config.raidJoinLimit>30 || config.raidMinutes<5 || config.raidMinutes>120)throw Error('入群防护配置无效');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.quietStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(config.quietEnd) || (config.quietEnabled && config.quietStart===config.quietEnd))throw Error('静默时段无效');
  if(!config.contentLocks || typeof config.contentLocks!=='object' || Array.isArray(config.contentLocks))throw Error('内容限制无效');
  for(const [kind,lock] of Object.entries(config.contentLocks)){if(!CONTENT_LOCK_TYPES.includes(kind) || !lock || typeof lock.enabled!=='boolean' || !['delete','ban'].includes(lock.action))throw Error('内容限制无效');}
  if(!Array.isArray(config.knowledgeBase) || config.knowledgeBase.length>50)throw Error('知识库无效');
  const commands=new Set();
  for(const item of config.knowledgeBase){if(!item || typeof item.id!=='string' || typeof item.title!=='string' || item.title.length>40 || typeof item.command!=='string' || (item.command && !/^[a-z][a-z0-9_]{0,31}$/.test(item.command)) || (item.command && commands.has(item.command)) || typeof item.response!=='string' || !item.response || item.response.length>2500 || typeof item.enabled!=='boolean' || !Array.isArray(item.triggers) || item.triggers.length>12 || item.triggers.some(x=>typeof x!=='string'||!x||x.length>80) || (!item.command&&!item.triggers.length))throw Error('知识库条目无效');commands.add(item.command);}
  return config;
}
export function diffValues(before,after){
  const changes=[];for(const key of new Set([...Object.keys(before||{}),...Object.keys(after||{})]))if(JSON.stringify(before?.[key])!==JSON.stringify(after?.[key]))changes.push({field:key,before:before?.[key]??null,after:after?.[key]??null});return changes;
}
