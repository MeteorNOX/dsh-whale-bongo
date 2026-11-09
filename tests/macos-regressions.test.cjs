const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '..')
const widget = fs.readFileSync(path.join(root, 'assets/widget.js'), 'utf8')
function fn(name) {
  const start = widget.indexOf('  function ' + name + '(')
  assert.notEqual(start, -1)
  // These functions end at their own two-space closing brace.
  const end = widget.indexOf('\n  }', start) + 4
  return widget.slice(start, end)
}
function keyboard() {
  const hits = [], released = [], forwarded = []
  const context = vm.createContext({
    window: {}, document: { visibilityState: 'visible' }, root: { style: {}, contains: () => false },
    desktopMode: false, desktopPageActive: false, menuOpen: false,
    cfg: { filterShortcutKeys: true }, MODIFIER_KEYS: {}, activeInputs: new Set(),
    lastKeyCode: null, lastHandIndex: 0, hands: ['left', 'right'],
    beginInput: (id, hand) => { context.activeInputs.add(id); hits.push([id, hand]) },
    endInput: (id) => { context.activeInputs.delete(id); released.push(id) },
    postDesktopKey: (action, event) => forwarded.push([action, event.code]),
  })
  vm.runInContext(['widgetVisible', 'onKeyDown', 'onKeyUp'].map(fn).join('\n'), context)
  return { context, hits, released, forwarded, key: { isTrusted: true, key: 'a', code: 'KeyA' } }
}
test('macOS page keys still animate with no native sampler', () => {
  const {context:c,hits,released,key} = keyboard()
  c.onKeyDown(key); c.onKeyUp(key)
  assert.equal(hits.length, 1); assert.deepEqual(released, ['key:KeyA'])
})
test('held/repeated keys do not create duplicate taps; different keys alternate', () => {
  const {context:c,hits,key} = keyboard()
  c.onKeyDown(key); c.onKeyDown(key); c.onKeyDown({...key,repeat:true})
  c.onKeyUp(key); c.onKeyDown({...key,key:'s',code:'KeyS'})
  assert.deepEqual(hits.map(h=>h[1]), ['left','right'])
})
test('shortcut and untrusted key events remain filtered', () => {
  const {context:c,hits,key} = keyboard()
  c.onKeyDown({...key,metaKey:true}); c.onKeyDown({...key,isTrusted:false})
  assert.equal(hits.length, 0)
})
test('hidden page forwards key down/up to desktop instead of dropping them', () => {
  const {context:c,hits,forwarded,key} = keyboard()
  c.desktopPageActive = true; c.root.style.display = 'none'
  c.onKeyDown(key); c.onKeyUp(key)
  assert.equal(hits.length,0); assert.deepEqual(forwarded,[['down','KeyA'],['up','KeyA']])
})
test('desktop uses its local keyboard when no native sampler exists', () => {
  const {context:c,hits,key} = keyboard()
  c.desktopMode = true; c.document.visibilityState = 'hidden'
  c.onKeyDown(key); assert.equal(hits.length,1)
})
test('active Windows sampler suppresses local duplicates', () => {
  const {context:c,hits,key} = keyboard()
  c.window.__DSH_WHALE_PAGE_GLOBAL_KEYS = true
  c.onKeyDown(key); assert.equal(hits.length,0)
  c.onKeyDown({...key,__whaleGlobal:true}); assert.equal(hits.length,1)
})
test('SSE opening is not proof of keyboard support; status and reconnect fall back', () => {
  let stream, releases=0, closed=false
  const c=vm.createContext({ desktopMode:false, globalKeySource:null, BASE:'/test',
    window:{EventSource:class {constructor(){stream=this} addEventListener(n,f){this[n]=f} close(){closed=true}}},
    releaseAll(){releases++}, handleGlobalKeyPayload(){},
  })
  vm.runInContext(fn('startGlobalKeyStream')+'\n'+fn('stopGlobalKeyStream'),c)
  c.startGlobalKeyStream(); stream.onopen()
  assert.equal(c.window.__DSH_WHALE_PAGE_GLOBAL_KEYS,false)
  stream.status({data:JSON.stringify({supported:false,active:false})})
  assert.equal(c.window.__DSH_WHALE_PAGE_GLOBAL_KEYS,false); assert.equal(releases,0)
  stream.status({data:JSON.stringify({supported:true,active:true})})
  assert.equal(c.window.__DSH_WHALE_PAGE_GLOBAL_KEYS,true)
  stream.onerror(); assert.equal(c.window.__DSH_WHALE_PAGE_GLOBAL_KEYS,false)
  stream.status({data:JSON.stringify({supported:true,active:true})})
  c.stopGlobalKeyStream(); assert.equal(closed,true); assert.equal(c.window.__DSH_WHALE_PAGE_GLOBAL_KEYS,false)
})
function geometry() {
  const c=vm.createContext({
    desktopMode:true, cfg:{size:100}, window:{innerWidth:1440,innerHeight:900}, imageBottomNorm:1,
    cardEl:()=>null, desktopWindows:[{hwnd:'mac:42',left:100,top:300,right:800,bottom:700,width:700}],
    saveCfg(){},place(){},lastPlaceKey:'',curX:0,curY:0,lastDesktopFollowX:null,
    clamp:(n,a,b)=>Math.max(a,Math.min(b,n)),
  })
  vm.runInContext(['makeHorizontalAnchor','distanceToSegment','syncDesktopSnapTarget','magnetize'].map(fn).join('\n'),c)
  return c
}
test('macOS window top/bottom snap and far-away free placement', () => {
  const c=geometry()
  c.magnetize(350,205); assert.equal(c.cfg.snap.ref,'desktop-window'); assert.equal(c.cfg.snap.edge,'top')
  c.magnetize(350,595); assert.equal(c.cfg.snap.edge,'bottom'); assert.equal(c.cfg.snap.hwnd,'mac:42')
  c.magnetize(1000,400); assert.equal(c.cfg.snap.ref,'viewport')
})
test('mouse handoff release runs edge snapping', () => {
  const c=geometry()
  Object.assign(c,{mouseFollowing:true,curX:350,curY:205,applyFlip(){}})
  vm.runInContext(fn('setMouseFollow'),c)
  c.setMouseFollow({left:false})
  assert.equal(c.mouseFollowing,false); assert.equal(c.cfg.snap.ref,'desktop-window')
})
function helper(platform='darwin') {
  const filename=path.join(root,'runtime/electron-helper/main.js')
  const realRequire=createRequire(filename),sent=[]
  let nativeStarts=0,nativeStops=0,scaled=0
  const screen={screenToDipRect(_win,r){scaled++;return {x:r.x/2,y:r.y/2,width:r.width/2,height:r.height/2}}}
  const electron={app:{commandLine:{appendSwitch(){}},whenReady:()=>new Promise(()=>{}),on(){}},screen}
  const c=vm.createContext({
    require(name){
      if(name==='electron')return electron
      if(name==='./macos-monitor')return {createMacOSMonitor:()=>({start(){nativeStarts++},stop(){nativeStops++}})}
      return realRequire(name)
    },
    __dirname:path.dirname(filename),process:{platform,env:{},pid:100,stdout:{on(){},write(){}},stderr:{on(){},write(){}},on(){}},
    setTimeout,clearTimeout,setInterval,clearInterval,Buffer,
  })
  vm.runInContext(fs.readFileSync(filename,'utf8')+`\n globalThis.qa={toOverlayDipFor,startDesktopWindows,stopDesktopWindows,startMouseFollow,publishMouseFollow,setWin(w,d){win=w;if(d)activeEntryRef={win:w,display:d}},following(){return mouseFollowStarted}}`,c)
  const display={scaleFactor:2,workArea:{x:100,y:30,width:1200,height:800}}
  const window={isDestroyed:()=>false,getContentBounds:()=>display.workArea,webContents:{send:(...a)=>sent.push(a)}}
  c.qa.setWin(window, display)
  return {api:c.qa,entry:{display,win:window},sent,counts:()=>({nativeStarts,nativeStops,scaled})}
}
test('Retina macOS window geometry is already DIP, only subtract overlay origin', () => {
  const {api,entry,counts}=helper()
  const result=api.toOverlayDipFor(entry,[{hwnd:'mac:42',left:300,top:230,right:700,bottom:630}])
  assert.equal(result[0].left,200); assert.equal(result[0].top,200); assert.equal(result[0].right,600)
  assert.equal(counts().scaled,0)
})
test('Windows physical-pixel conversion stays intact', () => {
  const {api,entry,counts}=helper('win32')
  const result=api.toOverlayDipFor(entry,[{hwnd:'42',left:600,top:460,right:1400,bottom:1260}])
  assert.equal(result[0].left,200); assert.equal(result[0].top,200); assert.equal(counts().scaled,1)
})
test('macOS starts/stops the native monitor and releases handoff at mouse-up', () => {
  const {api,sent,counts}=helper()
  api.startDesktopWindows(); api.startMouseFollow()
  api.publishMouseFollow({left:true,x:500,y:400})
  assert.equal(sent.at(-1)[1].x,400); assert.equal(sent.at(-1)[1].y,370)
  api.publishMouseFollow({left:false,x:510,y:410}); assert.equal(api.following(),false)
  api.stopDesktopWindows(); assert.equal(counts().nativeStarts,1); assert.equal(counts().nativeStops,1)
})
test('handoff release uses the final pointer coordinates even without a preceding down sample', () => {
  const c=geometry()
  Object.assign(c,{mouseFollowing:false,curX:1000,curY:400,drag:null,root:{style:{}},
    clearModeHold(){},hideClientSnapIndicator(){},applyFlip(){},resetFollowBounce(){},setMoveImmediate(){}})
  vm.runInContext(fn('setMouseFollow'),c)
  c.setMouseFollow({left:false,x:400,y:255,offsetX:50,offsetY:50})
  assert.equal(c.curX,350); assert.equal(c.curY,205)
  assert.equal(c.cfg.snap.ref,'desktop-window'); assert.equal(c.cfg.snap.hwnd,'mac:42')
})
function hostMonitor(platform) {
  const {EventEmitter}=require('node:events')
  let child,spawns=0
  const statuses=[],keys=[]
  const c=vm.createContext({path,process:{platform},setTimeout,clearTimeout,
    spawn(){
      spawns++;child=new EventEmitter()
      child.stdout=new EventEmitter();child.stderr=new EventEmitter()
      child.stdout.setEncoding=child.stderr.setEncoding=()=>{}
      child.kill=()=>{};return child
    },
  })
  const code=fs.readFileSync(path.join(root,'global-keys-host.js'),'utf8')
    .replace(/^import .*$/gm,'').replace('export function createGlobalKeyMonitor','function createGlobalKeyMonitor')
  vm.runInContext(code,c)
  const monitor=c.createGlobalKeyMonitor({pkgRoot:root,onKey:k=>keys.push(k),onStatus:s=>statuses.push(s)})
  return {monitor,statuses,keys,getChild:()=>child,spawns:()=>spawns}
}
test('macOS host explicitly reports unsupported and never launches PowerShell', () => {
  const {monitor,spawns}=hostMonitor('darwin')
  monitor.start(); assert.equal(monitor.state().supported,false); assert.equal(monitor.state().active,false)
  assert.equal(spawns(),0);monitor.stop()
})
test('Windows host waits for native ready, dispatches keys, and ignores late events after stop', () => {
  const {monitor,getChild,keys}=hostMonitor('win32')
  monitor.start(); assert.equal(monitor.state().active,false)
  const child=getChild()
  child.stdout.emit('data','rea');assert.equal(monitor.state().active,false)
  child.stdout.emit('data','dy\n1|65|0|0|0|0\n')
  assert.equal(monitor.state().active,true);assert.equal(keys[0].code,'KeyA')
  monitor.stop();child.stdout.emit('data','ready\n');child.emit('close',0)
  assert.equal(monitor.state().active,false)
})

function motion() {
  const c = geometry()
  Object.assign(c, {
    widgetDisposed:false, mouseFollowing:false, desktopPageActive:false,
    desktopInputAnchor:{x:0,y:0}, drag:null, desktopSnapMissingAt:0,
    lastSnapTargetHwnd:'', lastDesktopFollowX:null, lastDesktopFollowY:null,
    desktopFollowFrame:0, lastFollowWindowRect:null,
    moveShell:{style:{}}, root:{style:{},classList:{add(){}}},
    followLean:0, followLeanV:0, followStretch:0, followStretchV:0, moveSquash:0, moveSquashV:0, moveSquashArmed:false,
    audioBeatEnabled:true, audioBeatStatus:'stopped', audioBeatBpm:0,
    audioBeatPhase:0, audioBeatGroove:0, audioBeatPeriod:0, audioBeatTargetPeriod:0,
    bodyStretch:0, springActive:false, springAnchorX:400, springAnchorY:300,
    springTargetAnchorX:400, springTargetAnchorY:300, springVX:0, springVY:0,
    MOVE_STIFFNESS_BASE:240, MOVE_STIFFNESS_RANGE:60, MOVE_DAMPING_BASE:36,
    MOVE_DAMPING_RANGE:6, MOVE_START_BASE:2.6, MOVE_START_RANGE:1.4,
    numberOr:(value,fallback)=>Number.isFinite(Number(value))?Number(value):fallback,
    applyFlip(){}, cancelPointerPress(){}, closeMenu(){}, updateSnapDots(){},
    evaluateModeHold(){}, requestDesktopDisplayAtEdge(){},
  })
  c.cfg.imageQBounceLevel=5
  vm.runInContext(['findDesktopWindow','anchorCenterX','moveBounceRatio','applyMoveShellTransform',
    'resetFollowBounce','pulseFollowBounce','stepFollowBounce','pulseAudioBeat','stepAudioGroove','clearFollowOffset','setFollowPosition',
    'setFollowImmediate','setMoveImmediate','retargetMove','stepMove',
    'onHitPointerMove','applyDesktopWindowFollow','scheduleDesktopWindowFollow','setDesktopWindows'].map(fn).join('\n'),c)
  return c
}

test('desktop drag can reach a window top near the screen boundary and register attachment immediately', () => {
  const c=motion(), targets=[]
  c.desktopWindows=[{hwnd:'mac:42',left:100,right:800,top:20,bottom:500,width:700}]
  c.window.whaleDesktop={setSnapTarget:t=>targets.push(t.hwnd)}
  c.drag={id:1,x:400,y:350,ox:350,oy:250,moved:false}
  c.onHitPointerMove({pointerId:1,clientX:400,clientY:20})
  assert.equal(c.curY,-80)
  c.magnetize(c.curX,c.curY)
  assert.equal(c.cfg.snap.ref,'desktop-window');assert.equal(c.cfg.snap.edge,'top')
  assert.deepEqual(targets,['mac:42'])
})

test('client page drag retains its visible top boundary', () => {
  const c=motion();c.desktopMode=false
  c.drag={id:1,x:400,y:350,ox:350,oy:250,moved:false}
  c.onHitPointerMove({pointerId:1,clientX:400,clientY:20})
  assert.equal(c.curY,4)
})

test('snap animation settles at a negative top without breaking the window attachment', () => {
  const c=motion();c.cfg.snap={ref:'desktop-window',hwnd:'mac:42',edge:'top'}
  c.setMoveImmediate(350,20);c.retargetMove(350,-80,true)
  for(let i=0;i<600;i++)c.stepMove(1/120)
  assert.equal(c.springActive,false);assert.equal(Number.parseFloat(c.root.style.top),-80)
})

test('fast window following pins the base, sways in both directions, and returns to rest', () => {
  const c=motion()
  c.cfg.snap={ref:'desktop-window',hwnd:'mac:42',edge:'top',anchorX:{mode:'ratio',value:.5}}
  c.curX=400;c.curY=200;c.lastDesktopFollowX=400
  c.place=()=>{const w=c.findDesktopWindow('mac:42');c.curX=c.anchorCenterX(c.cfg.snap.anchorX,w)-50;c.curY=w.top-100;c.setMoveImmediate(c.curX,c.curY)}
  c.root.style.transition='left 45ms linear, top 45ms linear'
  const rect=(left,top=300)=>({hwnd:'mac:42',left,right:left+700,top,bottom:top+400})
  c.setDesktopWindows([rect(260)])
  assert.equal(c.curX,560);assert.equal(c.root.style.left,'560.00px')
  assert.equal(c.curY,200);assert.equal(c.root.style.transition,'')
  c.stepMove(1/60);assert.ok(c.followLean>0)
  const velocity=c.followLeanV
  c.setDesktopWindows([rect(260)]) // Unchanged native heartbeat must not reset the animation.
  assert.equal(c.followLeanV,velocity)
  c.setDesktopWindows([rect(0)]);assert.ok(c.followLeanV<0)
  c.setDesktopWindows([rect(0,350)]) // Vertical movement follows without a new sideways impulse.
  assert.equal(c.curY,250);assert.ok(c.followLeanV<0)
  assert.ok(c.followStretchV>0)
  c.stepMove(1/60);assert.ok(c.followStretch>0)
  for(let i=0;i<600;i++)c.stepMove(1/120)
  assert.equal(c.moveShell.style.transform,'');assert.equal(c.cfg.snap.hwnd,'mac:42')
})

test('Q-bounce zero disables sway while retaining window following', () => {
  const c=motion();c.cfg.imageQBounceLevel=0
  c.pulseFollowBounce(200)
  for(let i=0;i<30;i++)c.stepMove(1/60)
  assert.equal(c.followLean,0);assert.equal(c.moveShell.style.transform,'')
})

test('temporary window loss keeps attachment; a closed window detaches after the grace period', () => {
  const c=motion();let now=1000;c.Date={now:()=>now}
  c.cfg.snap={ref:'desktop-window',hwnd:'mac:42',edge:'top'};c.curX=350;c.curY=200
  c.setDesktopWindows([]);assert.equal(c.cfg.snap.ref,'desktop-window')
  now=2000;c.setDesktopWindows([]);assert.equal(c.cfg.snap.ref,'desktop-window')
  now=3500;c.setDesktopWindows([]);assert.equal(c.cfg.snap.ref,'viewport')
  assert.equal(c.cfg.snap.x,350);assert.equal(c.cfg.snap.y,200)
})
