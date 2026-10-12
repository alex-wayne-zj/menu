#!/usr/bin/env python3
"""Isolated HTTP regression checks; no production credentials or database touched."""
import os, json, tempfile, subprocess, time, urllib.request, urllib.error, sqlite3, pathlib, socket
ROOT=pathlib.Path(__file__).resolve().parents[1]
ORIGIN='https://test.invalid'
def run():
    with tempfile.TemporaryDirectory() as tmp:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        cfg={'database':tmp+'/db.sqlite','images':tmp+'/images','origin':ORIGIN,'bind':f'127.0.0.1:{port}','invitations':[{'username':'friend','code':'test-private-invite'}],'image_python':str(ROOT/'.venv/bin/python'),'image_processor':str(ROOT/'backend/image_process.py')}
        conf=tmp+'/config.json';pathlib.Path(conf).write_text(json.dumps(cfg))
        env=dict(os.environ,MENU_CONFIG=conf,MENU_ADMIN_USERNAME='admin',MENU_ADMIN_PASSWORD='test-admin-password')
        binary=str(ROOT/'backend/target/release/menu-backend')
        subprocess.run([binary,'bootstrap'],env=env,check=True)
        repeated=subprocess.run([binary,'bootstrap'],env=dict(env,MENU_ADMIN_USERNAME='another-admin'),capture_output=True)
        assert repeated.returncode!=0, 'bootstrap must preserve the single administrator'
        proc=subprocess.Popen([binary],env=env,stdout=subprocess.DEVNULL)
        def api(method,path,data=None,cookie=None,status=200,origin=ORIGIN,raw=None,content='application/json'):
            headers={'Origin':origin,'Content-Type':content}
            if cookie: headers['Cookie']=cookie
            body=raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
            req=urllib.request.Request(f'http://127.0.0.1:{port}/api'+path,data=body,headers=headers,method=method)
            try:r=urllib.request.urlopen(req)
            except urllib.error.HTTPError as e:r=e
            payload=r.read();assert r.status==status,(method,path,r.status,payload)
            obj=json.loads(payload) if r.headers.get('Content-Type','').startswith('application/json') else payload
            return obj,r.headers.get('Set-Cookie','').split(';')[0]
        try:
            for _ in range(100):
                try:api('GET','/health');break
                except urllib.error.URLError:time.sleep(.05)
            api('GET','/dishes',status=401)
            for _ in range(12):api('POST','/auth/login',{'username':'unknown','password':'incorrect-password'},status=401)
            api('POST','/auth/login',{'username':'unknown','password':'incorrect-password'},status=429)
            api('POST','/auth/login',{'username':'admin','password':'test-admin-password'},status=403,origin='https://evil.invalid')
            admin,admin_cookie=api('POST','/auth/login',{'username':'admin','password':'test-admin-password'})
            friend,friend_cookie=api('POST','/auth/register',{'username':'friend','password':'test-friend-password','invite_code':'test-private-invite'})
            api('POST','/auth/register',{'username':'friend','password':'test-friend-password','invite_code':'test-private-invite'},status=409)
            api('GET','/admin/invitations',cookie=friend_cookie,status=403)
            inv,_=api('GET','/admin/invitations',cookie=admin_cookie);assert inv[0]['used']
            con=sqlite3.connect(cfg['database']);url='/menu/api/images/'+'a'*64+'.webp'
            con.execute('INSERT INTO images VALUES(?,?,?)',(url,admin['user']['id'],0));con.commit();con.close()
            d={'name':'番茄炒蛋','category':'家常菜','kind':'vegetable','image_url':url,'ingredients':'番茄、鸡蛋','notes':''}
            dish,_=api('POST','/dishes',d,admin_cookie)
            api('PUT',f"/dishes/{dish['id']}",dict(d,version=1),friend_cookie,status=403)
            api('DELETE',f"/dishes/{dish['id']}",cookie=friend_cookie,status=403)
            copied,_=api('POST',f"/dishes/{dish['id']}/copy",{},friend_cookie);assert copied['owner_id']==friend['user']['id']
            record={'date':'2026-01-01','items':[{'dish_id':dish['id'],'version':dish['version']}]}
            r,_=api('POST','/records',record,admin_cookie)
            api('POST','/records',record,admin_cookie,status=409)
            api('PUT',f"/records/{r['id']}",dict(record,version=1),friend_cookie,status=403)
            api('DELETE',f"/records/{r['id']}",cookie=friend_cookie,status=403)
            changed,_=api('PUT',f"/dishes/{dish['id']}",dict(d,name='新版菜名',ingredients='新配料',version=1),admin_cookie)
            api('PUT',f"/dishes/{dish['id']}",dict(d,version=1),admin_cookie,status=409)
            api('POST','/records',dict(record,date='2026-01-02'),admin_cookie,status=409)
            r2,_=api('POST','/records',{'date':'2026-01-02','items':[{'dish_id':dish['id'],'version':2}]},admin_cookie)
            api('PUT',f"/records/{r['id']}",{'date':'2026-01-02','version':1,'items':[{'snapshot_index':0}]},admin_cookie,status=409)
            old,_=api('PUT',f"/records/{r['id']}",{'date':'2026-01-03','version':1,'items':[{'snapshot_index':0}]},admin_cookie);assert old['items'][0]['ingredients']=='番茄、鸡蛋'
            api('POST','/records',{'date':'2100-01-01','items':[{'dish_id':dish['id'],'version':2}]},admin_cookie)
            stats,_=api('GET','/stats',cookie=admin_cookie);assert stats[0]['count']==2
            api('DELETE',f"/dishes/{dish['id']}",cookie=admin_cookie)
            records,_=api('GET','/records',cookie=friend_cookie);assert any(x['items'][0]['name']=='番茄炒蛋' for x in records)
            api('POST','/records',dict(record,date='2026-01-04'),admin_cookie,status=404)
            api('DELETE',f"/records/{r['id']}",cookie=admin_cookie)
            api('DELETE',f"/records/{r2['id']}",cookie=admin_cookie)
            stats,_=api('GET','/stats',cookie=admin_cookie);assert stats==[]
            png=subprocess.check_output([str(ROOT/'.venv/bin/python'),'-c',"from PIL import Image; import io,sys; b=io.BytesIO(); Image.new('RGB',(1600,1000),'orange').save(b,'PNG'); sys.stdout.buffer.write(b.getvalue())"])
            body=b'--boundary\r\nContent-Disposition: form-data; name="file"; filename="valid.png"\r\nContent-Type: image/png\r\n\r\n'+png+b'\r\n--boundary--\r\n'
            uploaded,_=api('POST','/images',cookie=admin_cookie,raw=body,content='multipart/form-data; boundary=boundary')
            name=uploaded['image_url'].split('/')[-1]
            dims=subprocess.check_output([str(ROOT/'.venv/bin/python'),'-c',"from PIL import Image; import sys; im=Image.open(sys.argv[1]); print(im.format,max(im.size))",str(pathlib.Path(cfg['images'])/name)]).decode().strip()
            assert dims=='WEBP 960',dims
            api('GET','/images/'+name,status=401)
            api('GET','/images/'+name,cookie=friend_cookie)
            bad=b'--boundary\r\nContent-Disposition: form-data; name="file"; filename="bad.jpg"\r\nContent-Type: image/jpeg\r\n\r\nnot an image\r\n--boundary--\r\n'
            api('POST','/images',cookie=admin_cookie,status=400,raw=bad,content='multipart/form-data; boundary=boundary')
            api('POST','/auth/password',{'old_password':'test-friend-password','new_password':'updated-friend-pass'},friend_cookie)
            api('GET','/auth/me',cookie=friend_cookie,status=401)
            _,friend_cookie=api('POST','/auth/login',{'username':'friend','password':'updated-friend-pass'})
            api('POST','/auth/logout',{},friend_cookie)
            api('GET','/auth/me',cookie=friend_cookie,status=401)
            print('PASS: auth/rate-limit/invite/CSRF/ownership/copy/version/date collisions/snapshots/future stats/upload/password/logout')
        finally:proc.terminate();proc.wait(timeout=10)
if __name__=='__main__':run()
