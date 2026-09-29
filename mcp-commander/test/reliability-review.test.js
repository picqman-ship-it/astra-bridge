// Independent operator regressions: private temp files only; no live jobs or service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { FileLock, readPrivate, writeAtomic } from '../dist/remote/durable.js';
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-review-'));
for (const malformed of [false, true]) {
  it(malformed ? 'review: malformed old lock is not permission to execute' : 'review: an old LIVE owner lock must never be stolen', { timeout: 5000 }, async () => {
    const dir = temporary(); const file = path.join(dir, 'lock'); let release;
    try {
      fs.writeFileSync(file, malformed ? '{' : JSON.stringify({pid:process.pid,nonce:'live-review-owner',at:Date.now()-60000}), {mode:0o600});
      fs.utimesSync(file, new Date(Date.now()-60000), new Date(Date.now()-60000));
      const lock = new FileLock(file, 10);
      await assert.rejects(async () => { release = await lock.acquire(150); }, /lock|owner|malformed|ambiguous|timed out/i);
    } finally { release?.(); fs.rmSync(dir,{recursive:true,force:true}); }
  });
}
it('review: group-readable private state fails closed', () => {
  const dir=temporary(); const file=path.join(dir,'record.json');
  try { fs.writeFileSync(file,'{}',{mode:0o600}); fs.chmodSync(file,0o644); assert.throws(()=>readPrivate(file,100),/mode|0600|permission|private/i); }
  finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
it('review: durable write must finish all bytes after a short write', () => {
  const dir=temporary(); const file=path.join(dir,'record.json'); const original=fs.writeSync;
  const expected=JSON.stringify({state:'pending',fingerprint:'x'.repeat(100)});
  try {
    fs.writeSync=function(fd,data,...args){
      if(Buffer.isBuffer(data)){const offset=typeof args[0]==='number'?args[0]:0;const length=typeof args[1]==='number'?args[1]:data.length-offset;return original(fd,data,offset,Math.min(length,7),args[2]??null);}
      return original(fd,data,...args);
    };
    writeAtomic(file,expected); fs.writeSync=original;
    assert.equal(fs.readFileSync(file,'utf8'),expected);
  } finally { fs.writeSync=original; fs.rmSync(dir,{recursive:true,force:true}); }
});
it('review: directory EIO must not be reported as durable success', () => {
  const dir=temporary(); const file=path.join(dir,'record.json'); const original=fs.fsyncSync;
  try {
    fs.fsyncSync=function(fd){if(fs.fstatSync(fd).isDirectory())throw Object.assign(new Error('simulated directory EIO'),{code:'EIO'});return original(fd);};
    assert.throws(()=>writeAtomic(file,'{"state":"pending"}'),/EIO|sync|durab/i);
  } finally { fs.fsyncSync=original; fs.rmSync(dir,{recursive:true,force:true}); }
});
// A status tool which can restart a worker and run commands must not claim to be read-only.
for (const name of ['job_status','job_list']) {
  it(`review: ${name} permission metadata matches worker-start side effects`, async () => {
    const {jobTools}=await import('../dist/remote/job-tools.js');let effects=0;
    const rec={v:1,id:'j0mg1abcde-0123456789abcdef',state:'queued',command:'true',cwd:'/tmp',shell:'/bin/sh',timeoutSec:30,keyHash:'a',fingerprint:'b',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),stdout:{bytes:0,dropped:0},stderr:{bytes:0,dropped:0},progress:null};
    const jobs={get:()=>rec,health:async()=>{effects++;return 'running';},list:()=>({jobs:[rec],total:1}),store:{workerHealth:()=>({state:'running'})}};
    const tool=jobTools(jobs).find(t=>t.name===name);
    await tool.handler(name==='job_status'?{jobId:rec.id}:{limit:20});
    assert(effects===0||tool.annotations?.readOnlyHint!==true,`${name} calls health() which can start commands, so it cannot claim readOnlyHint:true`);
  });
}
