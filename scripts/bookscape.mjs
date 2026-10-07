import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

// Fixed endpoint; never send the key to caller-supplied URLs or redirects.
const base = 'https://bot.jasonselect.com/bookscape/api/';
const [command, arg, hash] = process.argv.slice(2);
try {
  const key = (await readFile(new URL('../.bookscape-key', import.meta.url), 'utf8')).trim();
  let path, body;
  if (command === 'status') path='status';
  else if (command === 'draft') {
    path='draft';body={text:await readFile(arg,'utf8'),format:process.argv.includes('--plain')?'plain':'HTML',layout:process.argv.includes('--single')?'photo_caption':'separate'};
    const imageIndex=process.argv.indexOf('--image');
    if(imageIndex>=0){
      const imagePath=process.argv[imageIndex+1];const captionIndex=process.argv.indexOf('--caption');const caption=captionIndex>=0?process.argv[captionIndex+1]:'';
      const ext=extname(imagePath).toLowerCase();const mime=ext==='.png'?'image/png':['.jpg','.jpeg'].includes(ext)?'image/jpeg':'';
      if(!mime||!caption)throw new Error('图片仅支持 JPG/PNG，并需提供 --caption');
      body.image={data:(await readFile(imagePath)).toString('base64'),mime,name:basename(imagePath),caption};
    }
  }
  else if (command === 'preview') { path='preview';body={id:arg}; }
  else if (command === 'receipt') path='receipt?id='+encodeURIComponent(arg);
  else if (command === 'publish' && arg && hash) { path='publish';body={id:arg,confirmHash:hash}; }
  else if (command === 'edit' && arg && hash) { path='edit';body={messageId:Number(arg),text:await readFile(hash,'utf8'),format:process.argv.includes('--plain')?'plain':'HTML'}; }
  else throw new Error('用法：status | draft 文件 [--plain] [--single] [--image 图片 --caption 标题] | preview 草稿ID | receipt 草稿ID | publish 草稿ID 摘要 | edit 消息ID 文件 [--plain]');
  const response=await fetch(base+path,{method:body?'POST':'GET',redirect:'error',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});
  const result=await response.json();
  console.log(JSON.stringify(result,null,2));
  if(!response.ok)process.exitCode=1;
} catch {
  console.error('操作未确认完成。请检查命令、文件或网络；发送操作请先用 receipt 查询，勿新建相同内容重发。');
  process.exitCode=1;
}
