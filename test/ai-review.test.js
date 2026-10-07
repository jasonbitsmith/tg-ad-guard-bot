import {test} from 'node:test';
import assert from 'node:assert/strict';
import {aiReviewCandidate,parseAiReview} from '../src/ai-review.js';
test('AI 只接管不确定消息，明确黑名单和强规则不被覆盖',()=>{
  const text='邀请代理参加活动';
  assert.equal(aiReviewCandidate(text,{score:0}),true);
  assert.equal(aiReviewCandidate('服务器怎么样啊',{score:0}),false);
  for(const verdict of [{score:4},{score:1,deleteOnKeyword:true},{score:0,permanentBan:true}])assert.equal(aiReviewCandidate(text,verdict),false);
});
test('AI 确認广告必须有高置信度与原文证据，错误返回拒绝',()=>{
  const text='招募代理，联系我了解';
  const result=(value)=>({response:JSON.stringify({decision:'ad',confidence:0.99,reason:'明确招揽',evidence:['招募代理'],...value})});
  assert.equal(parseAiReview(result({}),text).decision,'ad');
  assert.equal(parseAiReview(result({confidence:0.94}),text).decision,'uncertain');
  assert.equal(parseAiReview(result({evidence:[]}),text).decision,'uncertain');
  assert.equal(parseAiReview(result({decision:'normal',evidence:[]}),text).decision,'normal');
  for(const value of [{evidence:['虚构内容']},{confidence:'0.99'},{confidence:2},{decision:'ban'},{reason:null},{evidence:['a']}])assert.throws(()=>parseAiReview(result(value),text));
  assert.throws(()=>parseAiReview({response:'不是 JSON'},text));
});
