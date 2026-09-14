const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MintApiError, nextStage, waitForEligibleStage } = require('../dist/stage-wait');
const stage = (start, label = 'Allowlist') => ({ label, start_time: new Date(start).toISOString(), end_time: new Date(start + 100000).toISOString() });
test('skips ended/current stages and sorts future stages', () => {
  assert.equal(nextStage({stages:[stage(5000,'Public'),stage(1000),stage(3000)]},2000).start,3000);
});
test('WL failure waits, refreshes schedule then checks eligibility again', async () => {
  let now=2000, attempts=0, refreshes=0;
  const result=await waitForEligibleStage({
    check:async()=>{if(++attempts===1) throw new MintApiError(422,'precondition failed'); return 'eligible';},
    schedule:async()=>{refreshes++;return {stages:[stage(4000)]};},
    now:()=>now,sleep:async ms=>{now+=ms;},log:()=>{},
  });
  assert.equal(result,'eligible'); assert.equal(attempts,2); assert.equal(now,4000); assert.equal(refreshes,2);
});
test('continues to a later Public stage if the next Allowlist also fails', async () => {
  let now=2000, attempts=0;
  await waitForEligibleStage({check:async()=>{if(++attempts<3) throw new MintApiError(422,'unavailable');return true;},
    schedule:async()=>({stages:[stage(4000),stage(6000,'Public')]}),now:()=>now,sleep:async ms=>{now+=ms;},log:()=>{}});
  assert.equal(attempts,3);assert.equal(now,6000);
});
test('API auth/rate limit and RPC failures never skip a stage', async () => {
  for(const error of [new MintApiError(401,'auth'),new MintApiError(429,'rate'),new Error('RPC')]) {
    await assert.rejects(waitForEligibleStage({check:async()=>{throw error;},schedule:async()=>{assert.fail('must not fetch schedule');},now:()=>0,sleep:async()=>{},log:()=>{}}),e=>e===error);
  }
});
test('stops when no future stage exists', async () => {
  await assert.rejects(waitForEligibleStage({check:async()=>{throw new MintApiError(422,'unavailable');},schedule:async()=>({stages:[]}),now:()=>0,sleep:async()=>{},log:()=>{}}),/没有下一个 mint 轮次/);
});
test('follows a rescheduled opening', async () => {
  let now=2000, calls=0, attempts=0;
  await waitForEligibleStage({check:async()=>{if(++attempts===1)throw new MintApiError(409,'closed');return true;},
    schedule:async()=>({stages:[stage(++calls===1?4000:8000)]}),now:()=>now,sleep:async ms=>{now+=ms;},log:()=>{}});
  assert.equal(now,8000);
});
