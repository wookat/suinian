import subprocess,time,json,os
from pathlib import Path
BASE=Path(__file__).parent
os.environ['DISPLAY']=':0'
notes=[
'梧桐公寓租房押金 3500 元已退回。',
'锦园物业电话是 0571-88001234。',
'绘图工具升级到 node 22.4.1 后 sharp 报错。',
'蓝鲸读书会在周六上午十点于湖畔书店集合。',
'栀子花每周三浇水 250 毫升。',
'星河展览的预约场次是下午两点半，入口在东门。',
'烘焙课堂做司康需要黄油 80 克和牛奶 120 毫升。',
'山茶色围巾放在衣柜第二层的白色收纳盒。',
'海鸥跑团的训练路线是沿江绿道往返六公里。']
def ev(s):
 return json.loads(subprocess.check_output(['python3',str(BASE/'cdp.py'),'eval',s]))
for i,n in enumerate(notes,2):
 if i < 5: continue
 pos=ev("(()=>{let r=document.querySelector('textarea[aria-label=\"快速记录\"]').getBoundingClientRect();return {x:r.x+30,y:r.y+20+outerHeight-innerHeight}})()")
 subprocess.run(['xdotool','mousemove',str(round(pos['x'])),str(round(pos['y'])),'click','1'],check=True)
 assert ev("document.activeElement.getAttribute('aria-label')")=='快速记录'
 subprocess.run(['xclip','-selection','clipboard'],input=n.encode(),check=True)
 subprocess.run(['xdotool','key','ctrl+v','Return'],check=True)
 time.sleep(2)
 deadline=time.time()+100
 while time.time()<deadline:
  state=ev("(()=>{let s=document.querySelector('main section');return s?{found:s.innerText.includes("+json.dumps(n.rstrip('。'))+"),pending:s.innerText.includes('AI 分拣中')}:null})()")
  if state and state['found'] and not state['pending']: break
  time.sleep(2)
 else:raise Exception('triage timeout '+str(i))
 subprocess.run(['python3',str(BASE/'cdp.py'),'shot',str(BASE/f'seed-{i:02}.png')],check=True)
 print('triaged',i,flush=True)
