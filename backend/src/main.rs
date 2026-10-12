use argon2::{
    Argon2, PasswordHasher, PasswordVerifier,
    password_hash::{PasswordHash, SaltString},
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use rand::{RngCore, rngs::OsRng};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
#[derive(Deserialize, Clone)]
struct Config {
    database: String,
    images: String,
    origin: String,
    #[serde(default = "default_bind")]
    bind: String,
    #[serde(default)]
    invitations: Vec<Invite>,
    #[serde(default = "default_python")]
    image_python: String,
    #[serde(default = "default_processor")]
    image_processor: String,
}
#[derive(Deserialize, Clone)]
struct Invite {
    username: String,
    code: String,
}
fn default_bind() -> String {
    "127.0.0.1:8079".into()
}
fn default_python() -> String {
    "/opt/menu/venv/bin/python".into()
}
fn default_processor() -> String {
    "/opt/menu/backend/image_process.py".into()
}
#[derive(Clone)]
struct App {
    db: Arc<Mutex<Connection>>,
    cfg: Config,
    attempts: Arc<Mutex<HashMap<String, (u64, u32)>>>,
    image_slots: Arc<tokio::sync::Semaphore>,
}
#[derive(Debug)]
struct Error(StatusCode, String, &'static str);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1,"code":self.2}))).into_response()
    }
}
type Result<T> = std::result::Result<T, Error>;
fn bad(s: &str) -> Error {
    Error(StatusCode::BAD_REQUEST, s.into(), "invalid")
}
fn conflict(s: &str) -> Error {
    Error(StatusCode::CONFLICT, s.into(), "conflict")
}
fn internal(e: impl std::fmt::Display) -> Error {
    eprintln!("database/operation failure: {e}");
    Error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "服务暂时不可用".into(),
        "internal",
    )
}
fn unauthorized() -> Error {
    Error(StatusCode::UNAUTHORIZED, "请先登录".into(), "unauthorized")
}
fn denied() -> Error {
    Error(
        StatusCode::FORBIDDEN,
        "只能修改自己的数据".into(),
        "forbidden",
    )
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn random() -> String {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    b.iter().map(|v| format!("{v:02x}")).collect()
}
fn hash(p: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(p.as_bytes(), &salt)
        .map(|x| x.to_string())
        .map_err(internal)
}
fn username(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 32
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(bad("用户名需为 1–32 位英文字母、数字、下划线或连字符"));
    }
    Ok(())
}
fn password(p: &str) -> Result<()> {
    if p.chars().count() < 10 || p.len() > 128 {
        return Err(bad("密码需为 10–128 个字符"));
    }
    Ok(())
}
#[derive(Clone, Serialize)]
struct User {
    id: i64,
    username: String,
    is_admin: bool,
}
fn auth(a: &App, h: &HeaderMap) -> Result<User> {
    let token = h
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.split(';')
                .find_map(|c| c.trim().strip_prefix("menu_session="))
        })
        .ok_or_else(unauthorized)?;
    a.db.lock().unwrap().query_row("SELECT u.id,u.username,u.is_admin FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=?1 AND s.expires>?2",params![token,now()],|r|Ok(User{id:r.get(0)?,username:r.get(1)?,is_admin:r.get(2)?})).optional().map_err(internal)?.ok_or_else(unauthorized)
}
fn origin(a: &App, h: &HeaderMap) -> Result<()> {
    if h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(a.cfg.origin.as_str()) {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "请求来源不允许".into(),
            "origin",
        ));
    }
    Ok(())
}
fn write(a: &App, h: &HeaderMap) -> Result<User> {
    origin(a, h)?;
    auth(a, h)
}
fn cookie(token: &str) -> String {
    format!("menu_session={token}; Path=/menu; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000")
}
fn session(a: &App, u: User) -> Result<Response> {
    let token = random();
    a.db.lock()
        .unwrap()
        .execute(
            "INSERT INTO sessions VALUES(?1,?2,?3)",
            params![token, u.id, now() + 2592000],
        )
        .map_err(internal)?;
    Ok((
        [(header::SET_COOKIE, cookie(&token))],
        Json(json!({"user":u})),
    )
        .into_response())
}
#[derive(Deserialize)]
struct Login {
    username: String,
    password: String,
}
async fn login(State(a): State<App>, h: HeaderMap, Json(v): Json<Login>) -> Result<Response> {
    origin(&a, &h)?;
    if v.username.len() > 64 || v.password.len() > 128 {
        return Err(bad("登录输入过长"));
    }
    let key = v.username.to_lowercase();
    {
        let mut m = a.attempts.lock().unwrap();
        if m.len() >= 1000 {
            m.retain(|_, x| now() - x.0 < 900);
        }
        if m.len() >= 1000 && !m.contains_key(&key) {
            return Err(Error(
                StatusCode::TOO_MANY_REQUESTS,
                "尝试过多，请稍后再试".into(),
                "rate_limit",
            ));
        }
        let n = m.entry(key.clone()).or_insert((now(), 0));
        if now() - n.0 > 900 {
            *n = (now(), 0)
        }
        if n.1 >= 12 {
            return Err(Error(
                StatusCode::TOO_MANY_REQUESTS,
                "尝试过多，15 分钟后再试".into(),
                "rate_limit",
            ));
        }
        n.1 += 1;
    }
    let found =
        a.db.lock()
            .unwrap()
            .query_row(
                "SELECT id,username,is_admin,password FROM users WHERE username=?1",
                [&v.username],
                |r| {
                    Ok((
                        User {
                            id: r.get(0)?,
                            username: r.get(1)?,
                            is_admin: r.get(2)?,
                        },
                        r.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(internal)?;
    let (u, p) = match found {
        Some(v) => v,
        None => (
            User {
                id: 0,
                username: String::new(),
                is_admin: false,
            },
            hash("dummy-password-for-timing")?,
        ),
    };
    let ok = PasswordHash::new(&p).ok().is_some_and(|p| {
        Argon2::default()
            .verify_password(v.password.as_bytes(), &p)
            .is_ok()
    });
    if !ok || u.id == 0 {
        return Err(Error(
            StatusCode::UNAUTHORIZED,
            "用户名或密码错误".into(),
            "credentials",
        ));
    }
    a.attempts.lock().unwrap().remove(&key);
    session(&a, u)
}
#[derive(Deserialize)]
struct Register {
    username: String,
    password: String,
    invite_code: String,
}
async fn register(State(a): State<App>, h: HeaderMap, Json(v): Json<Register>) -> Result<Response> {
    origin(&a, &h)?;
    password(&v.password)?;
    username(&v.username)?;
    let config_path = std::env::var("MENU_CONFIG").unwrap_or("/etc/menu/config.json".into());
    let cfg: Config =
        serde_json::from_slice(&std::fs::read(config_path).map_err(internal)?).map_err(internal)?;
    if !cfg
        .invitations
        .iter()
        .any(|i| i.username == v.username && i.code == v.invite_code)
    {
        return Err(bad("邀请码不正确或不属于此用户名"));
    }
    let p = hash(&v.password)?;
    let u = {
        let mut db = a.db.lock().unwrap();
        let t = db.transaction().map_err(internal)?;
        let exists: bool = t
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM users WHERE username=?1)",
                [&v.username],
                |r| r.get(0),
            )
            .map_err(internal)?;
        if exists {
            return Err(conflict("该邀请码已使用或账户已存在"));
        }
        t.execute(
            "INSERT INTO users(username,password,is_admin) VALUES(?1,?2,0)",
            params![v.username, p],
        )
        .map_err(internal)?;
        let id = t.last_insert_rowid();
        t.commit().map_err(internal)?;
        User {
            id,
            username: v.username,
            is_admin: false,
        }
    };
    session(&a, u)
}
async fn me(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    Ok(Json(json!({"user":auth(&a,&h)?})))
}
async fn logout(State(a): State<App>, h: HeaderMap) -> Result<Response> {
    write(&a, &h)?;
    if let Some(t) = h
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.split(';')
                .find_map(|c| c.trim().strip_prefix("menu_session="))
        })
    {
        a.db.lock()
            .unwrap()
            .execute("DELETE FROM sessions WHERE token=?1", [t])
            .map_err(internal)?;
    }
    Ok((
        [(
            header::SET_COOKIE,
            "menu_session=; Path=/menu; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
        )],
        Json(json!({"ok":true})),
    )
        .into_response())
}
#[derive(Deserialize)]
struct Password {
    old_password: String,
    new_password: String,
}
async fn change_password(
    State(a): State<App>,
    h: HeaderMap,
    Json(v): Json<Password>,
) -> Result<Json<Value>> {
    let u = write(&a, &h)?;
    password(&v.new_password)?;
    let p: String =
        a.db.lock()
            .unwrap()
            .query_row("SELECT password FROM users WHERE id=?1", [u.id], |r| {
                r.get(0)
            })
            .map_err(internal)?;
    if !PasswordHash::new(&p).ok().is_some_and(|p| {
        Argon2::default()
            .verify_password(v.old_password.as_bytes(), &p)
            .is_ok()
    }) {
        return Err(bad("旧密码错误"));
    }
    let p = hash(&v.new_password)?;
    let mut db = a.db.lock().unwrap();
    let t = db.transaction().map_err(internal)?;
    t.execute("UPDATE users SET password=?1 WHERE id=?2", params![p, u.id])
        .map_err(internal)?;
    t.execute("DELETE FROM sessions WHERE user_id=?1", [u.id])
        .map_err(internal)?;
    t.commit().map_err(internal)?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Reset {
    username: String,
    new_password: String,
}
async fn reset_password(
    State(a): State<App>,
    h: HeaderMap,
    Json(v): Json<Reset>,
) -> Result<Json<Value>> {
    if !write(&a, &h)?.is_admin {
        return Err(denied());
    }
    password(&v.new_password)?;
    let p = hash(&v.new_password)?;
    let mut db = a.db.lock().unwrap();
    let t = db.transaction().map_err(internal)?;
    let id = t
        .query_row(
            "SELECT id FROM users WHERE username=?1",
            [v.username],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map_err(internal)?
        .ok_or_else(|| bad("账户不存在"))?;
    t.execute("UPDATE users SET password=?1 WHERE id=?2", params![p, id])
        .map_err(internal)?;
    t.execute("DELETE FROM sessions WHERE user_id=?1", [id])
        .map_err(internal)?;
    t.commit().map_err(internal)?;
    Ok(Json(json!({"ok":true})))
}
async fn invitations(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    if !auth(&a, &h)?.is_admin {
        return Err(denied());
    }
    let path = std::env::var("MENU_CONFIG").unwrap_or("/etc/menu/config.json".into());
    let cfg: Config =
        serde_json::from_slice(&std::fs::read(path).map_err(internal)?).map_err(internal)?;
    let db = a.db.lock().unwrap();
    let mut rows = Vec::new();
    for i in cfg.invitations {
        let used: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM users WHERE username=?1)",
                [&i.username],
                |r| r.get(0),
            )
            .map_err(internal)?;
        rows.push(json!({"username":i.username,"code":i.code,"used":used}));
    }
    Ok(Json(json!(rows)))
}
async fn users(State(a): State<App>, h: HeaderMap) -> Result<Json<Vec<User>>> {
    auth(&a, &h)?;
    let db = a.db.lock().unwrap();
    let mut s = db
        .prepare("SELECT id,username,is_admin FROM users ORDER BY id")
        .map_err(internal)?;
    let v = s
        .query_map([], |r| {
            Ok(User {
                id: r.get(0)?,
                username: r.get(1)?,
                is_admin: r.get(2)?,
            })
        })
        .map_err(internal)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(internal)?;
    Ok(Json(v))
}
#[derive(Serialize, Deserialize, Clone)]
struct Dish {
    id: i64,
    owner_id: i64,
    owner_name: String,
    name: String,
    category: String,
    kind: String,
    image_url: String,
    ingredients: String,
    notes: String,
    is_example: bool,
    version: i64,
}
fn dish_row(r: &rusqlite::Row) -> rusqlite::Result<Dish> {
    Ok(Dish {
        id: r.get(0)?,
        owner_id: r.get(1)?,
        owner_name: r.get(2)?,
        name: r.get(3)?,
        category: r.get(4)?,
        kind: r.get(5)?,
        image_url: r.get(6)?,
        ingredients: r.get(7)?,
        notes: r.get(8)?,
        is_example: r.get(9)?,
        version: r.get(10)?,
    })
}
const DISH_SELECT: &str = "SELECT d.id,d.owner_id,u.username,d.name,d.category,d.kind,d.image_url,d.ingredients,d.notes,d.is_example,d.version FROM dishes d JOIN users u ON u.id=d.owner_id";
fn get_dish(db: &Connection, id: i64) -> Result<Dish> {
    db.query_row(&format!("{DISH_SELECT} WHERE d.id=?1"), [id], dish_row)
        .optional()
        .map_err(internal)?
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "菜品已删除".into(), "not_found"))
}
async fn dishes(State(a): State<App>, h: HeaderMap) -> Result<Json<Vec<Dish>>> {
    auth(&a, &h)?;
    let db = a.db.lock().unwrap();
    let mut s = db
        .prepare(&format!("{DISH_SELECT} ORDER BY d.id DESC"))
        .map_err(internal)?;
    Ok(Json(
        s.query_map([], dish_row)
            .map_err(internal)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(internal)?,
    ))
}
#[derive(Deserialize)]
struct DishInput {
    name: String,
    category: String,
    kind: String,
    image_url: String,
    ingredients: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    is_example: bool,
    version: Option<i64>,
}
fn text(s: &str, max: usize, required: bool) -> Result<String> {
    let s = s.trim();
    if (required && s.is_empty()) || s.chars().count() > max {
        return Err(bad("文字为空或超过长度限制"));
    }
    Ok(s.to_string())
}
fn valid_dish(db: &Connection, v: &mut DishInput, u: i64) -> Result<()> {
    v.name = text(&v.name, 40, true)?;
    v.category = text(&v.category, 20, true)?;
    v.ingredients = text(&v.ingredients, 5000, true)?;
    v.notes = text(&v.notes, 2000, false)?;
    if !["meat", "vegetable", "other"].contains(&v.kind.as_str()) {
        return Err(bad("请选择荤素标记"));
    }
    let allowed:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM images WHERE url=?1 AND owner_id=?2) OR EXISTS(SELECT 1 FROM dishes WHERE image_url=?1 AND owner_id=?2)",params![v.image_url,u],|r|r.get(0)).map_err(internal)?;
    if !allowed {
        return Err(bad("请先上传自己的封面图片"));
    }
    Ok(())
}
async fn create_dish(
    State(a): State<App>,
    h: HeaderMap,
    Json(mut v): Json<DishInput>,
) -> Result<Json<Dish>> {
    let u = write(&a, &h)?;
    let db = a.db.lock().unwrap();
    valid_dish(&db, &mut v, u.id)?;
    db.execute("INSERT INTO dishes(owner_id,name,category,kind,image_url,ingredients,notes,is_example) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![u.id,v.name,v.category,v.kind,v.image_url,v.ingredients,v.notes,v.is_example]).map_err(internal)?;
    Ok(Json(get_dish(&db, db.last_insert_rowid())?))
}
async fn update_dish(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<i64>,
    Json(mut v): Json<DishInput>,
) -> Result<Json<Dish>> {
    let u = write(&a, &h)?;
    let db = a.db.lock().unwrap();
    let d = get_dish(&db, id)?;
    if d.owner_id != u.id {
        return Err(denied());
    }
    if v.version != Some(d.version) {
        return Err(conflict("菜品已更新，请重新查看后保存"));
    }
    valid_dish(&db, &mut v, u.id)?;
    db.execute("UPDATE dishes SET name=?1,category=?2,kind=?3,image_url=?4,ingredients=?5,notes=?6,is_example=?7,version=version+1 WHERE id=?8",params![v.name,v.category,v.kind,v.image_url,v.ingredients,v.notes,v.is_example,id]).map_err(internal)?;
    Ok(Json(get_dish(&db, id)?))
}
async fn delete_dish(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>> {
    let u = write(&a, &h)?;
    let db = a.db.lock().unwrap();
    if get_dish(&db, id)?.owner_id != u.id {
        return Err(denied());
    }
    db.execute("DELETE FROM dishes WHERE id=?1", [id])
        .map_err(internal)?;
    Ok(Json(json!({"ok":true})))
}
async fn copy_dish(State(a): State<App>, h: HeaderMap, Path(id): Path<i64>) -> Result<Json<Dish>> {
    let u = write(&a, &h)?;
    let db = a.db.lock().unwrap();
    let d = get_dish(&db, id)?;
    db.execute("INSERT INTO dishes(owner_id,name,category,kind,image_url,ingredients,notes,is_example) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![u.id,d.name,d.category,d.kind,d.image_url,d.ingredients,d.notes,d.is_example]).map_err(internal)?;
    Ok(Json(get_dish(&db, db.last_insert_rowid())?))
}
async fn upload(State(a): State<App>, h: HeaderMap, mut form: Multipart) -> Result<Json<Value>> {
    let u = write(&a, &h)?;
    let _permit = a.image_slots.clone().try_acquire_owned().map_err(|_| {
        Error(
            StatusCode::TOO_MANY_REQUESTS,
            "图片正在处理，请稍后重试".into(),
            "busy",
        )
    })?;
    let field = form
        .next_field()
        .await
        .map_err(|_| bad("图片请求无效或超过 10 MB"))?
        .ok_or_else(|| bad("请选择图片"))?;
    if field.name() != Some("file") {
        return Err(bad("上传字段应为 file"));
    }
    let bytes = field.bytes().await.map_err(|_| bad("图片不得超过 10 MB"))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(bad("图片不得超过 10 MB"));
    }
    let name = random();
    let input = PathBuf::from(&a.cfg.images).join(format!("{name}.upload"));
    let output = PathBuf::from(&a.cfg.images).join(format!("{name}.webp"));
    tokio::fs::write(&input, bytes).await.map_err(internal)?;
    let result = tokio::process::Command::new(&a.cfg.image_python)
        .arg(&a.cfg.image_processor)
        .arg(&input)
        .arg(&output)
        .kill_on_drop(true)
        .output();
    let success = tokio::time::timeout(std::time::Duration::from_secs(20), result).await;
    let _ = tokio::fs::remove_file(input).await;
    if !matches!(success,Ok(Ok(ref r)) if r.status.success()) {
        let _ = tokio::fs::remove_file(output).await;
        return Err(bad("只支持有效 JPEG、PNG、WebP；图片尺寸不得过大"));
    }
    let url = format!("/menu/api/images/{name}.webp");
    a.db.lock()
        .unwrap()
        .execute(
            "INSERT INTO images(url,owner_id,created) VALUES(?1,?2,?3)",
            params![url, u.id, now()],
        )
        .map_err(internal)?;
    Ok(Json(json!({"image_url":url})))
}
async fn image(State(a): State<App>, h: HeaderMap, Path(name): Path<String>) -> Result<Response> {
    auth(&a, &h)?;
    if !name.ends_with(".webp")
        || name.len() != 69
        || !name.as_bytes()[..64].iter().all(|c| c.is_ascii_hexdigit())
    {
        return Err(bad("图片路径无效"));
    }
    let b = tokio::fs::read(PathBuf::from(&a.cfg.images).join(name))
        .await
        .map_err(|_| Error(StatusCode::NOT_FOUND, "图片不存在".into(), "not_found"))?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/webp"),
            (header::CACHE_CONTROL, "private, max-age=86400"),
        ],
        b,
    )
        .into_response())
}
#[derive(Serialize, Deserialize, Clone)]
struct Item {
    dish_id: i64,
    source_user: String,
    name: String,
    ingredients: String,
    image_url: String,
    kind: String,
}
#[derive(Serialize)]
struct Record {
    id: i64,
    owner_id: i64,
    owner_name: String,
    date: String,
    version: i64,
    items: Vec<Item>,
}
fn record_row(r: &rusqlite::Row) -> rusqlite::Result<Record> {
    let raw: String = r.get(5)?;
    let items = serde_json::from_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(Record {
        id: r.get(0)?,
        owner_id: r.get(1)?,
        owner_name: r.get(2)?,
        date: r.get(3)?,
        version: r.get(4)?,
        items,
    })
}
const RECORD_SELECT: &str = "SELECT r.id,r.owner_id,u.username,r.date,r.version,r.items FROM records r JOIN users u ON u.id=r.owner_id";
fn get_record(db: &Connection, id: i64) -> Result<Record> {
    db.query_row(&format!("{RECORD_SELECT} WHERE r.id=?1"), [id], record_row)
        .optional()
        .map_err(internal)?
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "记录不存在".into(), "not_found"))
}
#[derive(Deserialize)]
struct Filters {
    user_id: Option<i64>,
    date: Option<String>,
}
async fn records(
    State(a): State<App>,
    h: HeaderMap,
    Query(q): Query<Filters>,
) -> Result<Json<Vec<Record>>> {
    auth(&a, &h)?;
    let db = a.db.lock().unwrap();
    let mut s=db.prepare(&format!("{RECORD_SELECT} WHERE (?1 IS NULL OR r.owner_id=?1) AND (?2 IS NULL OR r.date=?2) ORDER BY r.date DESC,r.id DESC")).map_err(internal)?;
    Ok(Json(
        s.query_map(params![q.user_id, q.date], record_row)
            .map_err(internal)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(internal)?,
    ))
}
#[derive(Deserialize)]
struct Selected {
    dish_id: Option<i64>,
    version: Option<i64>,
    snapshot_index: Option<usize>,
}
#[derive(Deserialize)]
struct RecordInput {
    date: String,
    version: Option<i64>,
    items: Vec<Selected>,
}
fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || !b.is_ascii() || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let y = s[..4].parse::<u32>().unwrap_or(0);
    let m = s[5..7].parse::<u32>().unwrap_or(0);
    let d = s[8..].parse::<u32>().unwrap_or(0);
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => 0,
    };
    (1900..=2100).contains(&y) && d >= 1 && d <= days
}
fn make_items(db: &Connection, v: &RecordInput, old: Option<&Record>) -> Result<Vec<Item>> {
    if !valid_date(&v.date) {
        return Err(bad("日期无效"));
    }
    if v.items.is_empty() || v.items.len() > 100 {
        return Err(bad("请选择 1–100 道菜"));
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for s in &v.items {
        let item = if let Some(i) = s.snapshot_index {
            if s.dish_id.is_some() {
                return Err(bad("条目只能选择快照或菜品"));
            }
            old.and_then(|r| r.items.get(i))
                .cloned()
                .ok_or_else(|| bad("旧条目不存在"))?
        } else {
            let d = get_dish(db, s.dish_id.ok_or_else(|| bad("条目缺少菜品"))?)?;
            if s.version != Some(d.version) {
                return Err(conflict("已选菜品已变化，请重新查看后再保存"));
            }
            Item {
                dish_id: d.id,
                source_user: d.owner_name,
                name: d.name,
                ingredients: d.ingredients,
                image_url: d.image_url,
                kind: d.kind,
            }
        };
        if !seen.insert(item.dish_id) {
            return Err(bad("同一道菜不能重复选择"));
        }
        out.push(item)
    }
    Ok(out)
}
async fn create_record(
    State(a): State<App>,
    h: HeaderMap,
    Json(v): Json<RecordInput>,
) -> Result<Json<Record>> {
    let u = write(&a, &h)?;
    let mut db = a.db.lock().unwrap();
    let t = db.transaction().map_err(internal)?;
    let exists: bool = t
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM records WHERE owner_id=?1 AND date=?2)",
            params![u.id, v.date],
            |r| r.get(0),
        )
        .map_err(internal)?;
    if exists {
        return Err(conflict("此日期已有记录，请打开现有记录明确编辑"));
    }
    let items = make_items(&t, &v, None)?;
    t.execute(
        "INSERT INTO records(owner_id,date,items) VALUES(?1,?2,?3)",
        params![
            u.id,
            v.date,
            serde_json::to_string(&items).map_err(internal)?
        ],
    )
    .map_err(internal)?;
    let r = get_record(&t, t.last_insert_rowid())?;
    t.commit().map_err(internal)?;
    Ok(Json(r))
}
async fn update_record(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<i64>,
    Json(v): Json<RecordInput>,
) -> Result<Json<Record>> {
    let u = write(&a, &h)?;
    let mut db = a.db.lock().unwrap();
    let t = db.transaction().map_err(internal)?;
    let old = get_record(&t, id)?;
    if old.owner_id != u.id {
        return Err(denied());
    }
    if v.version != Some(old.version) {
        return Err(conflict("记录已变化，请重新打开"));
    }
    let exists: bool = t
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM records WHERE owner_id=?1 AND date=?2 AND id<>?3)",
            params![u.id, v.date, id],
            |r| r.get(0),
        )
        .map_err(internal)?;
    if exists {
        return Err(conflict("目标日期已有记录，请选择其他日期"));
    }
    let items = make_items(&t, &v, Some(&old))?;
    t.execute(
        "UPDATE records SET date=?1,items=?2,version=version+1 WHERE id=?3",
        params![v.date, serde_json::to_string(&items).map_err(internal)?, id],
    )
    .map_err(internal)?;
    let r = get_record(&t, id)?;
    t.commit().map_err(internal)?;
    Ok(Json(r))
}
async fn delete_record(
    State(a): State<App>,
    h: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>> {
    let u = write(&a, &h)?;
    let db = a.db.lock().unwrap();
    if get_record(&db, id)?.owner_id != u.id {
        return Err(denied());
    }
    db.execute("DELETE FROM records WHERE id=?1", [id])
        .map_err(internal)?;
    Ok(Json(json!({"ok":true})))
}
async fn stats(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    auth(&a, &h)?;
    let db = a.db.lock().unwrap();
    let mut s=db.prepare("SELECT r.owner_id,u.username,r.date,r.items FROM records r JOIN users u ON u.id=r.owner_id WHERE r.date<=date('now','+8 hours') ORDER BY r.date").map_err(internal)?;
    let rows = s
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(internal)?;
    let mut map: HashMap<(i64, i64), Value> = HashMap::new();
    for row in rows {
        let (uid, uname, date, raw) = row.map_err(internal)?;
        let items: Vec<Item> = serde_json::from_str(&raw).map_err(internal)?;
        for i in items {
            let e=map.entry((uid,i.dish_id)).or_insert(json!({"owner_id":uid,"owner_name":uname,"dish_id":i.dish_id,"source_user":i.source_user,"name":i.name,"count":0,"last_date":date}));
            e["count"] = json!(e["count"].as_u64().unwrap() + 1);
            e["last_date"] = json!(date);
        }
    }
    Ok(Json(json!(map.into_values().collect::<Vec<_>>())))
}
fn init(c: &Config) -> std::result::Result<Connection, Box<dyn std::error::Error>> {
    if let Some(p) = std::path::Path::new(&c.database).parent() {
        std::fs::create_dir_all(p)?
    }
    std::fs::create_dir_all(&c.images)?;
    let db = Connection::open(&c.database)?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT NOT NULL UNIQUE,password TEXT NOT NULL,is_admin INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS images(url TEXT PRIMARY KEY,owner_id INTEGER NOT NULL REFERENCES users(id),created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS dishes(id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id INTEGER NOT NULL REFERENCES users(id),name TEXT NOT NULL,category TEXT NOT NULL,kind TEXT NOT NULL,image_url TEXT NOT NULL,ingredients TEXT NOT NULL,notes TEXT NOT NULL,is_example INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id INTEGER NOT NULL REFERENCES users(id),date TEXT NOT NULL,items TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,UNIQUE(owner_id,date));")?;
    db.execute("DELETE FROM sessions WHERE expires<?1", [now()])?;
    Ok(db)
}
fn cleanup(a: &App) -> Result<()> {
    let db = a.db.lock().unwrap();
    let mut stmt=db.prepare("SELECT url FROM images WHERE created<?1 AND NOT EXISTS(SELECT 1 FROM dishes WHERE image_url=images.url)").map_err(internal)?;
    let urls = stmt
        .query_map([now().saturating_sub(86400)], |r| r.get::<_, String>(0))
        .map_err(internal)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(internal)?;
    drop(stmt);
    for url in urls {
        let name = url.rsplit('/').next().unwrap_or("");
        if name.len() != 69
            || !name.ends_with(".webp")
            || !name.as_bytes()[..64].iter().all(|c| c.is_ascii_hexdigit())
        {
            continue;
        }
        match std::fs::remove_file(PathBuf::from(&a.cfg.images).join(name)) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(internal(e)),
        };
        db.execute("DELETE FROM images WHERE url=?1", [url])
            .map_err(internal)?;
    }
    db.execute("DELETE FROM sessions WHERE expires<?1", [now()])
        .map_err(internal)?;
    Ok(())
}
#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let cfg_path = std::env::var("MENU_CONFIG").unwrap_or("/etc/menu/config.json".into());
    let cfg: Config = serde_json::from_slice(&std::fs::read(cfg_path)?)?;
    let db = init(&cfg)?;
    if std::env::args().nth(1).as_deref() == Some("bootstrap") {
        let has_admin: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM users WHERE is_admin=1)",
            [],
            |row| row.get(0),
        )?;
        if has_admin {
            return Err("管理员已存在，bootstrap 仅用于首次初始化".into());
        }
        let admin_username =
            std::env::var("MENU_ADMIN_USERNAME").unwrap_or_else(|_| "admin".into());
        username(&admin_username).map_err(|e| e.1)?;
        let p = std::env::var("MENU_ADMIN_PASSWORD")?;
        password(&p).map_err(|e| e.1)?;
        let h = hash(&p).map_err(|e| e.1)?;
        db.execute(
            "INSERT INTO users(username,password,is_admin) VALUES(?1,?2,1)",
            params![admin_username, h],
        )?;
        return Ok(());
    }
    let bind = cfg.bind.clone();
    let app = App {
        db: Arc::new(Mutex::new(db)),
        cfg,
        attempts: Arc::new(Mutex::new(HashMap::new())),
        image_slots: Arc::new(tokio::sync::Semaphore::new(1)),
    };
    let housekeeping = app.clone();
    tokio::spawn(async move {
        loop {
            if cleanup(&housekeeping).is_err() {
                eprintln!("housekeeping failed; will retry on next interval");
            }
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
    let router = Router::new()
        .route("/api/health", get(|| async { Json(json!({"ok":true})) }))
        .route("/api/auth/login", post(login))
        .route("/api/auth/register", post(register))
        .route("/api/auth/me", get(me))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/password", post(change_password))
        .route("/api/admin/reset-password", post(reset_password))
        .route("/api/admin/invitations", get(invitations))
        .route("/api/users", get(users))
        .route("/api/dishes", get(dishes).post(create_dish))
        .route("/api/dishes/{id}", put(update_dish).delete(delete_dish))
        .route("/api/dishes/{id}/copy", post(copy_dish))
        .route("/api/images", post(upload))
        .route("/api/images/{name}", get(image))
        .route("/api/records", get(records).post(create_record))
        .route(
            "/api/records/{id}",
            put(update_record).delete(delete_record),
        )
        .route("/api/stats", get(stats))
        .layer(DefaultBodyLimit::max(11 * 1024 * 1024))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(listener, router).await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dates() {
        assert!(valid_date("2024-02-29"));
        assert!(!valid_date("2025-02-29"));
        assert!(!valid_date("2026-13-01"));
        assert!(!valid_date("2026-01-00"));
    }
    #[test]
    fn lengths() {
        assert!(text(" 菜 ", 40, true).unwrap() == "菜");
        assert!(text(" ", 40, true).is_err());
        assert!(text(&"菜".repeat(41), 40, true).is_err());
    }
}
