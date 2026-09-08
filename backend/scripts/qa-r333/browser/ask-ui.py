import asyncio,json,sys,urllib.request,subprocess,os,time,base64
from pathlib import Path
import websockets
BASE=Path(__file__).parent
os.environ['DISPLAY']=':0'
async def main():
 tab=next(t for t in json.load(urllib.request.urlopen('http://localhost:29229/json')) if t['type']=='page' and 'suinian.zalize.com' in t['url'])
 async with websockets.connect(tab['webSocketDebuggerUrl'],max_size=20000000,ping_interval=None) as ws:
  seq=0
  async def cmd(m,p):
   nonlocal seq
   seq+=1; i=seq
   await ws.send(json.dumps({'id':i,'method':m,'params':p}))
   while True:
    r=json.loads(await ws.recv())
    if r.get('id')==i:return r.get('result',{})
  async def ev(s):return (await cmd('Runtime.evaluate',{'expression':s,'returnByValue':True,'awaitPromise':True})).get('result',{}).get('value')
  async def shot(label):
   r=await cmd('Page.captureScreenshot',{'format':'png'})
   (BASE/(sys.argv[1]+'-'+label+'.png')).write_bytes(base64.b64decode(r['data']))
  await ev("""(()=>{if(window.__qaInstalled)return;window.__qaInstalled=true;window.__qaEvents=[];let f=window.fetch;window.fetch=async(...a)=>{let r=await f(...a);if(String(a[0]).includes('/api/ask')){let c=r.clone();(async()=>{let reader=c.body.getReader(),d=new TextDecoder(),s='';while(true){let x=await reader.read();if(x.done)break;s+=d.decode(x.value,{stream:true});let parts=s.split('\\n\\n');s=parts.pop();for(let p of parts){let e=p.match(/event: (\\w+)/);if(e)window.__qaEvents.push({event:e[1],time:Date.now(),bytes:p.length});}}})();}return r;};})()""")
  await ev("window.__qaEvents=[]")
  pos=await ev("""(()=>{let e=document.querySelector('textarea[placeholder="继续追问，Enter 发送…"]');let r=e.getBoundingClientRect();return {x:r.x+50,y:r.y+15+outerHeight-innerHeight}})()""")
  subprocess.run(['xdotool','mousemove',str(round(pos['x'])),str(round(pos['y'])),'click','1'],check=True)
  assert await ev("document.activeElement.tagName")=='TEXTAREA'
  subprocess.run(['xclip','-selection','clipboard'],input=sys.argv[2].encode(),check=True)
  subprocess.run(['xdotool','key','ctrl+v','Return'],check=True)
  start=time.time(); seen=set(); states=[]
  while time.time()-start<120:
   state=await ev("""(()=>{let e=[...document.querySelectorAll('.flex.justify-start')].at(-1);let t=e?.innerText||'';return {text:t,pending:[...e?.querySelectorAll('button')||[]].some(b=>b.innerText==='取消'),events:window.__qaEvents};})()""")
   text=state['text']
   phase='retrieval' if '正在检索相关笔记' in text else 'generating' if '正在生成回答' in text else 'delta' if state['pending'] and text.replace('取消','').strip() and '正在思考' not in text else 'thinking'
   if state['pending'] and phase not in seen:
    await shot(phase);seen.add(phase)
   if not states or states[-1]['length']!=len(text):states.append({'ms':round((time.time()-start)*1000),'length':len(text),'pending':state['pending'],'phase':phase})
   if any(e['event']=='done' for e in state['events']) and not state['pending']:
    await asyncio.sleep(.3);await shot('done');break
   await asyncio.sleep(.05)
  else:raise Exception('ask timeout')
  data=await ev("""(()=>{let e=[...document.querySelectorAll('.flex.justify-start')].at(-1);return {answer:e?.querySelector('p.whitespace-pre-wrap')?.innerText,markers:e?.querySelectorAll('button[aria-label^="跳转到引用笔记"]').length,refs:[...e?.querySelectorAll('[id^="ask-ref-"]')||[]].map(x=>({id:x.id,text:x.innerText})),events:window.__qaEvents}})()""")
  data['states']=states;data['question']=sys.argv[2];data['at']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
  if sys.argv[1].startswith('q'):
   (BASE/(sys.argv[1]+'.json')).write_text(json.dumps(data,ensure_ascii=False,indent=2))
   print(json.dumps(data,ensure_ascii=False))
  else:
   print(json.dumps({'markers':data['markers'],'refs':len(data['refs']),'events':data['events'],'states':states},ensure_ascii=False))
asyncio.run(main())
