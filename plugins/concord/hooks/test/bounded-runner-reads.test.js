'use strict';
// #339: every runner read of an artifact a subagent writes goes through the bounded reader.
// Each case runs in a child process with a timeout, so a read that blocks on a FIFO fails the
// case instead of hanging the suite.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./temp-dir');
const { MAX_BYTES } = require('../../core/bounded-artifact');

const SKIP = process.platform === 'win32';
const CORE = path.join(__dirname, '..', '..', 'core');
const KINDS = ['fifo', 'oversized'];

// Replaces `file` with a FIFO or a file one byte over the bound.
function plant(file, kind) {
  if (kind === 'fifo') assert.strictEqual(spawnSync('mkfifo', [file]).status, 0);
  else { const fd = fs.openSync(file, 'w'); fs.ftruncateSync(fd, MAX_BYTES + 1); fs.closeSync(fd); }
}

function runChild(script, args) {
  const child = spawnSync(process.execPath, ['-e', script, ...args], { timeout: 8000, encoding: 'utf8' });
  assert.strictEqual(child.error, undefined, `child blocked or failed to start: ${child.error}`);
  return child;
}

for (const kind of KINDS) {
  test(`fixDeclaration refuses a ${kind} fix artifact as a harness failure`, { skip: SKIP }, () => {
    const dir = tempDir('concord-fixdecl-');
    plant(path.join(dir, 'round-1-fix-g.json'), kind);
    const child = runChild(
      'try{require(process.argv[1]).fixDeclaration(process.argv[2],1,"g");process.exit(2)}catch(e){process.exit(/^harness-failure:/.test(e.message)?0:3)}',
      [path.join(CORE, 'round-plan.js'), dir],
    );
    assert.strictEqual(child.status, 0, `exit ${child.status}`);
  });
}

test('fixDeclaration still returns null for a missing or malformed fix artifact', () => {
  const dir = tempDir('concord-fixdecl-');
  const { fixDeclaration } = require(path.join(CORE, 'round-plan.js'));
  assert.strictEqual(fixDeclaration(dir, 1, 'g'), null);
  fs.writeFileSync(path.join(dir, 'round-1-fix-g.json'), '{nope');
  assert.strictEqual(fixDeclaration(dir, 1, 'g'), null);
});

// One runner round in which the subagent at `site` leaves a hostile artifact.
// Exit 0: the runner rejected with a harness failure. 2: it carried on. 3: it failed otherwise.
const RUNNER = `
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const [runnerPath,stateDir,site,kind,max]=process.argv.slice(1);
const {runReviewUntilGreen}=require(runnerPath);
const fixGroup={groupId:'g',findingIds:['correctness:bug'],rootCause:'r',invariants:[],changeClass:'local',action:'fix',findings:[{id:'correctness:bug',file:'a.txt',span:'s',summary:'m'}]};
const art=(name)=>path.join(stateDir,'round-1-'+name+'.json');
const good=(file,body)=>fs.writeFileSync(file,JSON.stringify(body));
const plant=(file)=>{if(kind==='fifo')spawnSync('mkfifo',[file]);else{const fd=fs.openSync(file,'w');fs.ftruncateSync(fd,Number(max)+1);fs.closeSync(fd)}};
let recorded=0;
const cli=(args)=>{
  const [verb]=args;
  if(verb==='round-start')return{decision:'work',round:1,stateDir,targetType:'git',dodPassed:true,intentApplied:false,gateApplied:false};
  if(verb==='artifact-normalize')return{status:'ok'};
  if(verb==='telemetry-slot')return{engine:'codex',provider:'openai',artifactPath:args[2],attempt:1};
  if(verb==='plan-fixes')return{protocolVersion:2,planId:'p',transactionScope:'group',fixes:site==='fix'?fixGroup.findings:[],fixGroups:site==='fix'?[fixGroup]:[]};
  if(verb==='commit-fix')return{committed:true,sha:'abc'};
  if(verb==='record')return recorded++===0&&(site==='panel'||site==='vote')?{decision:{panelPending:true}}:{decision:{continue:false},handoff:'LGTM'};
  if(verb==='gate-panel-round-start')return{round:1,rejectedIds:[]};
  if(verb==='gate-panel-round-record')return{status:'done'};
  throw new Error('unexpected CLI '+verb);
};
const spawn=({role,prompt})=>{
  if(role==='correctness'){site==='verify'?plant(art('correctness')):good(art('correctness'),{status:'ok',examined:['a.txt'],findings:[]})}
  if(role==='verify')good(art('verify'),{status:'ok',rejected:[]});
  if(role==='fix'){site==='fix'?plant(art('fix-g')):good(art('fix-g'),{status:'ok',edited:true,groupId:'g',files:['a.txt']})}
  if(role==='certify')good(art('certify-g'),{status:'ok'});
  if(role.startsWith('gate-panel-')&&role!=='gate-panel-verify'){
    const lens=role.slice('gate-panel-'.length),file=path.join(stateDir,'round-1-gate-panel-1-'+lens+'.json');
    if(site==='panel'&&lens==='ac-coverage')plant(file);
    else good(file,{status:'ok',findings:site==='vote'&&lens==='ac-coverage'?[{id:'gate:ac-coverage:gap',file:'a.js',span:'x',summary:'s'}]:[]});
  }
  if(role==='gate-panel-verify'){const file=prompt.match(/to (\\S+\\.json)\\./)[1];site==='vote'?plant(file):good(file,{status:'ok',survives:false})}
  return{status:0};
};
runReviewUntilGreen({ref:'feature/x',repoRoot:'/repo',runCli:cli,spawn}).then(
  ()=>process.exit(2),(e)=>process.exit(/harness-failure:/.test(e.message)?0:3));
`;

for (const site of ['verify', 'fix', 'panel', 'vote']) {
  for (const kind of KINDS) {
    test(`runner ends the round with a harness failure on a ${kind} ${site} artifact`, { skip: SKIP }, () => {
      const stateDir = tempDir('concord-runner-reads-');
      const child = runChild(RUNNER, [path.join(CORE, 'codex-review-runner.js'), stateDir, site, kind, String(MAX_BYTES)]);
      assert.strictEqual(child.status, 0, `exit ${child.status}: ${child.stderr}`);
    });
  }
}
