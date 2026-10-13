import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, FormEvent } from "react";
import { api, ApiError } from "./api";
import type { Dish, User, RecordEntry, Stat } from "./types";
import { recommend } from "./recommend";
const kindName = { meat: "荤菜", vegetable: "素菜", other: "其他" };
const today = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(
    new Date(),
  );
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试";
function Photo({ url, name }: { url: string; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return failed || !url ? (
    <div className="photo placeholder" role="img" aria-label={name}>
      ◯<span>好好吃饭</span>
    </div>
  ) : (
    <img
      className="photo"
      src={url}
      alt={name}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement;
    const el = ref.current!;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          'button,input,textarea,select,[tabindex="0"]',
        ),
      ).filter((x) => !x.hasAttribute("disabled"));
    focusable()[0]?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (e.key === "Tab") {
        const a = focusable();
        const first = a[0],
          last = a[a.length - 1];
        if (!el.contains(document.activeElement)) {
          e.preventDefault();
          first?.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener("keydown", handler);
      before?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="quiet" onClick={onClose} aria-label="关闭弹窗">
            关闭
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
function Login({ onSuccess }: { onSuccess: (u: User) => void }) {
  const [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [show, setShow] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (register && f.get("password") !== f.get("confirm"))
      return setError("两次输入的密码不一致");
    setBusy(true);
    setError("");
    try {
      const r = await api<{ user: User }>(
        register ? "/auth/register" : "/auth/login",
        "POST",
        {
          username: f.get("username"),
          password: f.get("password"),
          invite_code: f.get("invite_code"),
        },
      );
      onSuccess(r.user);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <div className="brand">
        <small>今天，好好吃饭</small>
        <h1>食记</h1>
        <p>留住常做的菜，选好今天这一餐。</p>
      </div>
      <form className="login-card" onSubmit={submit}>
        <h2>{register ? "一起好好吃饭" : "欢迎回到食记"}</h2>
        {register && <p className="muted">由站主邀请，与你的朋友共享菜谱。</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <label>
          用户名
          <input
            name="username"
            autoComplete="username"
            maxLength={32}
            required
          />
        </label>
        <label>
          密码
          <input
            name="password"
            type={show ? "text" : "password"}
            autoComplete={register ? "new-password" : "current-password"}
            minLength={10}
            maxLength={128}
            required
          />
        </label>
        <button
          type="button"
          className="text-button"
          onClick={() => setShow(!show)}
        >
          {show ? "隐藏密码" : "显示密码"}
        </button>
        {register && (
          <>
            <label>
              确认密码
              <input
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={10}
                required
              />
            </label>
            <label>
              邀请码
              <input name="invite_code" autoComplete="off" required />
            </label>
          </>
        )}
        <button className="primary wide" disabled={busy}>
          {busy ? "请稍候…" : register ? "创建账户" : "登录"}
        </button>
        <button
          type="button"
          className="text-button wide"
          onClick={() => {
            setRegister(!register);
            setError("");
          }}
        >
          {register ? "已有账户，去登录" : "有邀请码？创建账户"}
        </button>
      </form>
    </main>
  );
}
export default function App() {
  const [user, setUser] = useState<User | null>(null),
    [checking, setChecking] = useState(true),
    [bootError, setBootError] = useState(""),
    [dishes, setDishes] = useState<Dish[]>([]),
    [records, setRecords] = useState<RecordEntry[]>([]),
    [stats, setStats] = useState<Stat[]>([]),
    [users, setUsers] = useState<User[]>([]),
    [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState("menu"),
    [scope, setScope] = useState("mine"),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState("全部"),
    [historyUser, setHistoryUser] = useState("all"),
    [historyDate, setHistoryDate] = useState("");
  const [cart, setCart] = useState<Dish[]>([]),
    [cartReady, setCartReady] = useState(false),
    [date, setDate] = useState(today()),
    [modal, setModal] = useState<
      | "detail"
      | "form"
      | "cart"
      | "record"
      | "edit-record"
      | "account"
      | "random"
      | null
    >(null),
    [detail, setDetail] = useState<Dish | null>(null),
    [editDish, setEditDish] = useState<Dish | null>(null),
    [record, setRecord] = useState<RecordEntry | null>(null),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState(""),
    [recommendation, setRecommendation] = useState<{
      dish: Dish | null;
      message: string;
    }>({ dish: null, message: "" }),
    [conflict, setConflict] = useState<RecordEntry | null>(null);
  async function check() {
    setChecking(true);
    setBootError("");
    try {
      setUser((await api<{ user: User }>("/auth/me")).user);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401))
        setBootError(errorText(e));
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    void check();
  }, []);
  useEffect(() => {
    const expired = () => {
      setModal(null);
      setUser(null);
      setDishes([]);
      setRecords([]);
      setCart([]);
      setCartReady(false);
      setNotice("");
    };
    window.addEventListener("shiji-session-expired", expired);
    return () => window.removeEventListener("shiji-session-expired", expired);
  }, []);
  async function refresh() {
    setLoading(true);
    setLoadError("");
    try {
      const [d, r, s, u] = await Promise.all([
        api<Dish[]>("/dishes"),
        api<RecordEntry[]>("/records"),
        api<Stat[]>("/stats"),
        api<User[]>("/users"),
      ]);
      setDishes(d);
      setRecords(r);
      setStats(s);
      setUsers(u);
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (!user) return;
    setCartReady(false);
    let saved: Dish[] = [];
    try {
      const parsed = JSON.parse(
        localStorage.getItem("shiji-cart-" + user.id) || "[]",
      );
      if (Array.isArray(parsed))
        saved = parsed.filter(
          (d) =>
            d &&
            typeof d.id === "number" &&
            typeof d.version === "number" &&
            typeof d.name === "string",
        );
    } catch {}
    setCart(saved);
    setCartReady(true);
    void refresh();
  }, [user?.id]);
  useEffect(() => {
    if (user && cartReady)
      localStorage.setItem("shiji-cart-" + user.id, JSON.stringify(cart));
  }, [cart, user, cartReady]);
  function open(m: typeof modal) {
    setActionError("");
    setConflict(null);
    setModal(m);
  }
  function close() {
    setModal(null);
    setActionError("");
    setConflict(null);
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setActionError("");
    try {
      await fn();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function add(d: Dish) {
    setCart((c) => (c.some((x) => x.id === d.id) ? c : [...c, d]));
    setNotice("已加入今天想吃");
  }
  function showDish(d: Dish) {
    setDetail(d);
    open("detail");
  }
  const filtered = useMemo(
    () =>
      dishes.filter(
        (d) =>
          (tab === "manage" || scope === "mine"
            ? d.owner_id === user?.id
            : scope === "friends"
              ? d.owner_id !== user?.id
              : true) &&
          (category === "全部" || d.category === category) &&
          (!search ||
            `${d.name} ${d.ingredients}`
              .toLowerCase()
              .includes(search.toLowerCase())),
      ),
    [dishes, scope, search, category, user, tab],
  );
  const categories = [
    "全部",
    ...new Set([
      "家常菜",
      "肉菜",
      "蔬菜",
      "汤羹",
      "主食",
      ...dishes.map((d) => d.category),
    ]),
  ];
  function random(previous?: number) {
    setRecommendation(recommend(filtered, cart, previous));
    open("random");
  }
  async function saveCart(update = false) {
    await action(async () => {
      if (!cart.length) throw Error("请至少选择一道菜");
      if (date > today()) throw Error("做菜日期不能晚于今天");
      const changed = cart.filter((d) => {
        const current = dishes.find((x) => x.id === d.id);
        return !current || current.version !== d.version;
      });
      if (changed.length)
        throw Error("菜谱有更新或已删除，请逐项重新查看后保存");
      const existing = records.find(
        (r) => r.owner_id === user!.id && r.date === date,
      );
      if (existing && !update) {
        setConflict(existing);
        return;
      }
      const body = {
        date,
        items: cart.map((d) => ({ dish_id: d.id, version: d.version })),
        ...(existing ? { version: existing.version } : {}),
      };
      try {
        const saved = await api<RecordEntry>(
          existing ? `/records/${existing.id}` : "/records",
          existing ? "PUT" : "POST",
          body,
        );
        setRecord(saved);
        setCart([]);
        setModal("record");
        setTab("history");
        setNotice("已保存到饮食记录");
        setConflict(null);
        await refresh();
      } catch (e) {
        await refresh();
        throw e;
      }
    });
  }
  if (checking) return <main className="loading">正在打开你的饭册…</main>;
  if (!user)
    return bootError ? (
      <main className="login">
        <p className="error">{bootError}</p>
        <button onClick={() => void check()}>重新连接</button>
      </main>
    ) : (
      <Login onSuccess={setUser} />
    );
  return (
    <>
      <div className="shell">
        <header className="top">
          <div className="brand">
            <small>今天，好好吃饭</small>
            <h1>食记</h1>
          </div>
          <button className="account" onClick={() => open("account")}>
            {user.username}
          </button>
        </header>
        <nav className="main-nav" aria-label="页面导航">
          {[
            ["menu", "选菜"],
            ["history", "饮食记录"],
            ["manage", "我的菜谱"],
          ].map(([id, title]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => {
                setTab(id);
                setCategory("全部");
                setSearch("");
              }}
            >
              {title}
            </button>
          ))}
        </nav>
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button
              className="text-button"
              onClick={() => setNotice("")}
              aria-label="关闭提示"
            >
              ×
            </button>
          </div>
        )}
        {loadError && (
          <div className="error" role="alert">
            {loadError} <button onClick={() => void refresh()}>重试加载</button>
          </div>
        )}
        {tab !== "history" ? (
          <>
            <div className="page-heading">
              <div>
                <p className="eyebrow">
                  {tab === "manage"
                    ? "MY RECIPE BOOK"
                    : "A LITTLE EVERYDAY JOY"}
                </p>
                <h2>{tab === "manage" ? "我的拿手菜" : "今天想吃什么？"}</h2>
                <p className="muted">
                  {tab === "manage"
                    ? "慢慢收集，留住熟悉的好味道。"
                    : "从常做的菜里，选好今天这一餐。"}
                </p>
              </div>
              <button
                className="primary"
                onClick={() => {
                  setEditDish(null);
                  open("form");
                }}
              >
                ＋ 新增菜品
              </button>
            </div>
            <section className="filters">
              {tab === "menu" && (
                <div className="segments">
                  {[
                    ["mine", "我的"],
                    ["friends", "朋友"],
                    ["all", "全部"],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      className={scope === id ? "selected" : ""}
                      onClick={() => setScope(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <label className="search">
                <span className="sr-only">搜索菜名或配料</span>
                <input
                  placeholder="搜索菜名，或一种食材…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    className="text-button"
                    onClick={() => setSearch("")}
                    aria-label="清空搜索"
                  >
                    ×
                  </button>
                )}
              </label>
            </section>
            <div className="categories" aria-label="菜品分类">
              {categories.map((c) => (
                <button
                  key={c}
                  className={category === c ? "selected" : ""}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="random-banner">
              <div>
                <strong>还没想好？</strong>
                <span> 随机一道，补一点灵感。</span>
              </div>
              <button onClick={() => random()}>帮我挑 ↗</button>
            </div>
            {loading && !dishes.length ? (
              <div className="empty">正在翻开菜谱…</div>
            ) : filtered.length ? (
              <div className="dish-grid">
                {filtered.map((d) => {
                  const s = stats.find(
                    (s) =>
                      s.dish_id === d.id &&
                      s.source_user === d.owner_name &&
                      s.owner_id === d.owner_id,
                  );
                  const selected = cart.some((x) => x.id === d.id);
                  return (
                    <article className="dish-card" key={d.id}>
                      <button
                        className="image-button"
                        onClick={() => showDish(d)}
                        aria-label={`查看${d.name}配料`}
                      >
                        <Photo url={d.image_url} name={d.name} />
                      </button>
                      <div className="dish-content">
                        <div className="dish-title">
                          <button onClick={() => showDish(d)}>{d.name}</button>
                          <span className={"kind " + d.kind}>
                            {kindName[d.kind]}
                          </span>
                        </div>
                        <p className="source">
                          {d.owner_name} 的菜谱 · {d.category}
                        </p>
                        <p className="ingredients-preview">{d.ingredients}</p>
                        <div className="card-bottom">
                          <small>
                            {s
                              ? `做过 ${s.count} 次 · 最近 ${s.last_date.slice(5)}`
                              : "等下一次开饭"}
                          </small>
                          <button
                            className={selected ? "added" : "add"}
                            disabled={selected}
                            onClick={() => add(d)}
                          >
                            {selected ? "已加入" : "＋ 加入"}
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty">
                <span className="empty-symbol">◯</span>
                <h3>{search ? "还没找到这道菜" : "这页饭册还是空的"}</h3>
                <p>试试其他分类或食材，也可以添加一道拿手菜。</p>
                <button
                  onClick={() => {
                    setEditDish(null);
                    open("form");
                  }}
                >
                  新增菜品
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="page-heading">
              <div>
                <p className="eyebrow">OUR DAILY TABLE</p>
                <h2>每天吃了什么</h2>
                <p className="muted">一餐一记，留下日常里的小满足。</p>
              </div>
            </div>
            <div className="history-filters">
              <label>
                记录者
                <select
                  value={historyUser}
                  onChange={(e) => setHistoryUser(e.target.value)}
                >
                  <option value="all">所有人</option>
                  {users.map((u) => (
                    <option value={u.id} key={u.id}>
                      {u.username}
                      {u.id === user.id ? "（我）" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                做菜日期
                <input
                  type="date"
                  max={today()}
                  value={historyDate}
                  onChange={(e) => setHistoryDate(e.target.value)}
                />
              </label>
              <button
                className="quiet"
                onClick={() => {
                  setHistoryDate("");
                  setHistoryUser("all");
                }}
              >
                清除筛选
              </button>
            </div>
            <div className="history-list">
              {records
                .filter(
                  (r) =>
                    r.date <= today() &&
                    (historyUser === "all" ||
                      r.owner_id === Number(historyUser)) &&
                    (!historyDate || r.date === historyDate),
                )
                .sort((a, b) => b.date.localeCompare(a.date))
                .map((r) => (
                  <button
                    className="history-row"
                    key={r.id}
                    onClick={() => {
                      setRecord(r);
                      open("record");
                    }}
                  >
                    <div className="date-mark">
                      <strong>{r.date.slice(8)}</strong>
                      <small>{r.date.slice(0, 7)}</small>
                    </div>
                    <div>
                      <span className="source">
                        {r.owner_name} 的餐桌 · {r.items.length} 道菜
                      </span>
                      <h3>{r.items.map((i) => i.name).join(" · ")}</h3>
                      <p className="muted">查看当时的配料记录</p>
                    </div>
                    <span>↗</span>
                  </button>
                ))}
            </div>
            {!records.some(
              (r) =>
                r.date <= today() &&
                (historyUser === "all" || r.owner_id === Number(historyUser)) &&
                (!historyDate || r.date === historyDate),
            ) && (
              <div className="empty">
                <h3>还没有饮食记录</h3>
                <p>选几道喜欢的菜，开始记下第一餐。</p>
                <button onClick={() => setTab("menu")}>去选菜</button>
              </div>
            )}
          </>
        )}
        <footer className="footnote">食记 · 认真吃饭，悠闲生活</footer>
      </div>
      <div className="cart-bar">
        <div>
          <strong>今天想吃 · {cart.length} 道</strong>
          <small>
            {cart.length
              ? cart.map((d) => d.name).join("、")
              : "选几道菜，组成今天的菜单"}
          </small>
        </div>
        <button onClick={() => open("cart")}>查看菜单 →</button>
      </div>
      {modal && (
        <Modal
          title={
            modal === "detail"
              ? detail?.name || "菜品详情"
              : modal === "form"
                ? editDish
                  ? "编辑菜品"
                  : "新增拿手菜"
                : modal === "cart"
                  ? "今天想吃"
                  : modal === "record"
                    ? "这一餐的记录"
                    : modal === "edit-record"
                      ? "编辑饮食记录"
                      : modal === "account"
                        ? "我的账户"
                        : "今天的灵感"
          }
          onClose={close}
        >
          {actionError && (
            <p className="error" role="alert">
              {actionError}
            </p>
          )}
          {modal === "detail" && detail && (
            <>
              <Photo url={detail.image_url} name={detail.name} />
              <div className="detail-meta">
                <span className={"kind " + detail.kind}>
                  {kindName[detail.kind]}
                </span>
                <span>
                  {detail.category} · {detail.owner_name} 的菜谱
                </span>
              </div>
              {detail.is_example && (
                <small className="muted">AI 生成的示例图片</small>
              )}
              <h3>需要的配料</h3>
              <p className="preline">{detail.ingredients}</p>
              {detail.notes && (
                <>
                  <h3>厨房小记</h3>
                  <p className="preline">{detail.notes}</p>
                </>
              )}
              <div className="actions">
                <button
                  className="primary"
                  disabled={cart.some((d) => d.id === detail.id)}
                  onClick={() => add(detail)}
                >
                  {cart.some((d) => d.id === detail.id)
                    ? "已加入今天想吃"
                    : "加入今天想吃"}
                </button>
                {detail.owner_id === user.id ? (
                  <button
                    onClick={() => {
                      setEditDish(detail);
                      open("form");
                    }}
                  >
                    编辑菜品
                  </button>
                ) : (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const copied = await api<Dish>(
                          `/dishes/${detail.id}/copy`,
                          "POST",
                          {},
                        );
                        await refresh();
                        setDetail(copied);
                        setNotice("已复制到你的菜谱，可独立编辑");
                      })
                    }
                  >
                    复制到我的菜谱
                  </button>
                )}
              </div>
            </>
          )}
          {modal === "form" && (
            <DishForm
              dish={editDish}
              busy={busy}
              onSave={(data, file) =>
                void action(async () => {
                  let image_url = data.image_url;
                  if (file) {
                    const f = new FormData();
                    f.set("file", file);
                    image_url = (
                      await api<{ image_url: string }>("/images", "POST", f)
                    ).image_url;
                  }
                  const saved = await api<Dish>(
                    editDish ? `/dishes/${editDish.id}` : "/dishes",
                    editDish ? "PUT" : "POST",
                    {
                      ...data,
                      image_url,
                      ...(editDish ? { version: editDish.version } : {}),
                    },
                  );
                  await refresh();
                  setDetail(saved);
                  setModal("detail");
                  setNotice("菜谱已保存");
                })
              }
              onDelete={
                editDish
                  ? () => {
                      if (
                        window.confirm(
                          "删除这道菜？已有饮食记录中的菜名和配料会保留。",
                        )
                      )
                        void action(async () => {
                          await api(`/dishes/${editDish.id}`, "DELETE");
                          await refresh();
                          close();
                          setNotice("菜品已删除");
                        });
                    }
                  : undefined
              }
            />
          )}
          {modal === "cart" && (
            <>
              <p className="muted">配料按每道菜原文保留，不合并食材。</p>
              {!cart.length ? (
                <div className="empty">
                  <h3>还没选好今天的菜</h3>
                  <button onClick={close}>继续选菜</button>
                </div>
              ) : (
                <>
                  {cart.map((d) => {
                    const current = dishes.find((x) => x.id === d.id),
                      changed = !current || current.version !== d.version;
                    return (
                      <div className="cart-item" key={d.id}>
                        <Photo url={d.image_url} name={d.name} />
                        <div>
                          <strong>{d.name}</strong>
                          <small>
                            {d.owner_name} · {kindName[d.kind]}
                          </small>
                          <details>
                            <summary>查看配料</summary>
                            <p className="preline">{d.ingredients}</p>
                          </details>
                          {changed && (
                            <p className="error">
                              {current
                                ? "菜谱已更新，请查看新内容"
                                : "菜品已删除，请移除"}
                              {current && (
                                <button
                                  onClick={() => {
                                    setCart((c) =>
                                      c.map((x) =>
                                        x.id === d.id ? current : x,
                                      ),
                                    );
                                    setDetail(current);
                                    setModal("detail");
                                  }}
                                >
                                  查看并采用最新内容
                                </button>
                              )}
                            </p>
                          )}
                        </div>
                        <button
                          className="text-button"
                          onClick={() =>
                            setCart((c) => c.filter((x) => x.id !== d.id))
                          }
                          aria-label={`移除${d.name}`}
                        >
                          移除
                        </button>
                      </div>
                    );
                  })}
                  <div className="cart-controls">
                    <label>
                      做菜日期
                      <input
                        type="date"
                        max={today()}
                        value={date}
                        onChange={(e) => {
                          setDate(e.target.value);
                          setConflict(null);
                        }}
                        required
                      />
                    </label>
                    <button
                      className="text-button"
                      onClick={() => {
                        if (window.confirm("清空所有已选菜品？")) setCart([]);
                      }}
                    >
                      清空选择
                    </button>
                  </div>
                  {conflict && (
                    <div className="conflict">
                      <h3>这一天已记录过</h3>
                      <p>{conflict.items.map((i) => i.name).join("、")}</p>
                      <p>更新会替换这一天的菜单，其他日期保持独立。</p>
                      <button
                        onClick={() => {
                          setRecord(conflict);
                          setModal("record");
                        }}
                      >
                        查看现有记录
                      </button>
                    </div>
                  )}
                  <button
                    className="primary wide"
                    disabled={busy || !date}
                    onClick={() => void saveCart(!!conflict)}
                  >
                    {busy
                      ? "正在保存…"
                      : conflict
                        ? "确认更新当日记录"
                        : "生成菜单"}
                  </button>
                </>
              )}
            </>
          )}
          {modal === "random" && (
            <>
              <p className="muted">{recommendation.message}</p>
              {recommendation.dish && (
                <>
                  <Photo
                    url={recommendation.dish.image_url}
                    name={recommendation.dish.name}
                  />
                  <h3>{recommendation.dish.name}</h3>
                  <p>
                    {recommendation.dish.owner_name} 的菜谱 ·{" "}
                    {kindName[recommendation.dish.kind]}
                  </p>
                  <div className="actions">
                    <button
                      className="primary"
                      disabled={cart.some(
                        (d) => d.id === recommendation.dish!.id,
                      )}
                      onClick={() => {
                        add(recommendation.dish!);
                        close();
                      }}
                    >
                      加入今天想吃
                    </button>
                    <button onClick={() => random(recommendation.dish!.id)}>
                      换一道
                    </button>
                    <button onClick={() => showDish(recommendation.dish!)}>
                      查看配料
                    </button>
                  </div>
                </>
              )}
            </>
          )}
          {modal === "record" && record && (
            <>
              <p className="record-heading">
                {record.date} · {record.owner_name} 的餐桌
              </p>
              {record.items.map((i, n) => (
                <div className="snapshot" key={n}>
                  <div className="snapshot-title">
                    <Photo url={i.image_url} name={i.name} />
                    <div>
                      <h3>{i.name}</h3>
                      <small>{i.source_user} 的菜谱 · 当时的配料</small>
                    </div>
                  </div>
                  <p className="preline">{i.ingredients}</p>
                </div>
              ))}
              {record.owner_id === user.id && (
                <div className="actions">
                  <button
                    className="primary"
                    onClick={() => open("edit-record")}
                  >
                    编辑记录
                  </button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          "删除这一天的饮食记录？其他日期不会受到影响。",
                        )
                      )
                        void action(async () => {
                          await api(`/records/${record.id}`, "DELETE");
                          await refresh();
                          close();
                          setNotice("饮食记录已删除");
                        });
                    }}
                  >
                    删除记录
                  </button>
                </div>
              )}
            </>
          )}
          {modal === "edit-record" && record && (
            <RecordForm
              record={record}
              dishes={dishes}
              busy={busy}
              onSave={(recordDate, items) =>
                void action(async () => {
                  if (
                    records.some(
                      (r) =>
                        r.owner_id === user.id &&
                        r.date === recordDate &&
                        r.id !== record.id,
                    )
                  )
                    throw Error(
                      "该日期已有你的记录，请选择其他日期；不会自动覆盖",
                    );
                  const saved = await api<RecordEntry>(
                    `/records/${record.id}`,
                    "PUT",
                    { date: recordDate, version: record.version, items },
                  );
                  setRecord(saved);
                  setModal("record");
                  setNotice("记录已更新");
                  await refresh();
                })
              }
            />
          )}
          {modal === "account" && (
            <Account
              user={user}
              busy={busy}
              onChange={(old_password, new_password) =>
                void action(async () => {
                  await api("/auth/password", "POST", {
                    old_password,
                    new_password,
                  });
                  setModal(null);
                  setUser(null);
                  setDishes([]);
                  setRecords([]);
                  setCart([]);
                  setCartReady(false);
                })
              }
              onReset={(username, new_password) =>
                void action(async () => {
                  await api("/admin/reset-password", "POST", {
                    username,
                    new_password,
                  });
                  if (username === user.username) {
                    setModal(null);
                    setUser(null);
                    setDishes([]);
                    setRecords([]);
                    setCart([]);
                    setCartReady(false);
                  } else {
                    setNotice("指定账户密码已重置");
                    close();
                  }
                })
              }
              onLogout={() =>
                void action(async () => {
                  await api("/auth/logout", "POST", {});
                  setModal(null);
                  setUser(null);
                  setDishes([]);
                  setRecords([]);
                  setCart([]);
                  setNotice("");
                  setCartReady(false);
                })
              }
            />
          )}
        </Modal>
      )}
    </>
  );
}
function DishForm({
  dish,
  busy,
  onSave,
  onDelete,
}: {
  dish: Dish | null;
  busy: boolean;
  onSave: (data: Partial<Dish>, file: File | null) => void;
  onDelete?: () => void;
}) {
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState(dish?.image_url || ""),
    [error, setError] = useState("");
  useEffect(
    () => () => {
      if (preview.startsWith("blob:")) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file && !dish?.image_url) return setError("请上传一张封面图片");
    const f = new FormData(e.currentTarget);
    onSave(
      {
        name: String(f.get("name")).trim(),
        category: String(f.get("category")).trim(),
        kind: f.get("kind") as Dish["kind"],
        ingredients: String(f.get("ingredients")).trim(),
        notes: String(f.get("notes")).trim(),
        image_url: dish?.image_url || "",
        is_example: file ? false : dish?.is_example || false,
      },
      file,
    );
  }
  return (
    <form onSubmit={submit} className="stack">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label>
        封面照片{preview && <Photo url={preview} name="封面预览" />}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (
              !["image/jpeg", "image/png", "image/webp"].includes(f.type) ||
              f.size > 10 * 1024 * 1024
            ) {
              setError("请选择 JPEG、PNG 或 WebP 图片，大小不超过 10 MB");
              e.target.value = "";
              return;
            }
            setError("");
            setFile(f);
            setPreview(URL.createObjectURL(f));
          }}
        />
      </label>
      <small className="muted">
        JPEG / PNG / WebP，最多 10 MB；上传后自动压缩。
      </small>
      <label>
        菜名
        <input name="name" defaultValue={dish?.name} maxLength={40} required />
      </label>
      <label>
        分类
        <input
          name="category"
          defaultValue={dish?.category || "家常菜"}
          list="category-options"
          maxLength={20}
          required
        />
        <datalist id="category-options">
          {["家常菜", "肉菜", "蔬菜", "汤羹", "主食"].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </datalist>
      </label>
      <label>
        荤素标记
        <select name="kind" defaultValue={dish?.kind || "other"} required>
          <option value="meat">荤菜</option>
          <option value="vegetable">素菜</option>
          <option value="other">其他</option>
        </select>
      </label>
      <label>
        配料说明
        <textarea
          aria-label="配料说明"
          name="ingredients"
          defaultValue={dish?.ingredients}
          maxLength={5000}
          rows={5}
          placeholder="鸡腿肉 300 g、土豆 2 个、生抽适量…"
          required
        />
      </label>
      <label>
        厨房小记（可选）
        <textarea
          aria-label="厨房小记（可选）"
          name="notes"
          defaultValue={dish?.notes}
          maxLength={2000}
          rows={3}
          placeholder="口味、替代配料或简单提示"
        />
      </label>
      <button className="primary wide" disabled={busy}>
        {busy ? "正在保存…" : "保存菜谱"}
      </button>
      {onDelete && (
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={onDelete}
        >
          删除菜品
        </button>
      )}
    </form>
  );
}
type EditItem =
  | { snapshot_index: number }
  | { dish_id: number; version: number };
function RecordForm({
  record,
  dishes,
  busy,
  onSave,
}: {
  record: RecordEntry;
  dishes: Dish[];
  busy: boolean;
  onSave: (date: string, items: EditItem[]) => void;
}) {
  const [date, setDate] = useState(record.date),
    [items, setItems] = useState<EditItem[]>(
      record.items.map((_, i) => ({ snapshot_index: i })),
    ),
    [addId, setAddId] = useState(""),
    [localError, setLocalError] = useState("");
  const usedIds = items.map((i) =>
    "snapshot_index" in i ? record.items[i.snapshot_index].dish_id : i.dish_id,
  );
  const available = dishes.filter((d) => !usedIds.includes(d.id));
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!items.length) return setLocalError("至少保留一道菜");
        setLocalError("");
        onSave(date, items);
      }}
    >
      {localError && <p className="error">{localError}</p>}
      <label>
        做菜日期
        <input
          type="date"
          max={today()}
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <p className="muted">
        旧条目保留当时的配料。只有点击“使用当前菜谱内容”才替换快照。
      </p>
      {items.map((item, index) => {
        const old =
          "snapshot_index" in item ? record.items[item.snapshot_index] : null;
        const current = dishes.find(
          (d) =>
            d.id === (old?.dish_id || ("dish_id" in item ? item.dish_id : 0)),
        );
        const display = old || current;
        return (
          <div className="edit-item" key={index}>
            <strong>{display?.name || "未知菜品"}</strong>
            <p className="preline">{display?.ingredients}</p>
            <div className="actions">
              <button
                type="button"
                className="text-button"
                onClick={() => setItems((x) => x.filter((_, i) => i !== index))}
              >
                移除
              </button>
              {old && current && (
                <button
                  type="button"
                  onClick={() =>
                    setItems((x) =>
                      x.map((v, i) =>
                        i === index
                          ? { dish_id: current.id, version: current.version }
                          : v,
                      ),
                    )
                  }
                >
                  使用当前菜谱内容
                </button>
              )}
            </div>
            {!old && <small className="muted">将保存当前菜谱配料</small>}
          </div>
        );
      })}
      <label>
        添加菜品
        <select value={addId} onChange={(e) => setAddId(e.target.value)}>
          <option value="">选择一道菜</option>
          {available.map((d) => (
            <option value={d.id} key={d.id}>
              {d.name} · {d.owner_name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={!addId}
        onClick={() => {
          const d = dishes.find((d) => d.id === Number(addId));
          if (d) setItems((i) => [...i, { dish_id: d.id, version: d.version }]);
          setAddId("");
        }}
      >
        ＋ 添加到这一餐
      </button>
      <button className="primary wide" disabled={busy}>
        {busy ? "正在保存…" : "保存记录修改"}
      </button>
    </form>
  );
}
function Account({
  user,
  busy,
  onChange,
  onReset,
  onLogout,
}: {
  user: User;
  busy: boolean;
  onChange: (old: string, next: string) => void;
  onReset: (username: string, next: string) => void;
  onLogout: () => void;
}) {
  const [error, setError] = useState(""),
    [invites, setInvites] = useState<
      { username: string; code: string; used: boolean }[]
    >([]),
    [inviteError, setInviteError] = useState("");
  useEffect(() => {
    if (user.is_admin)
      api<{ username: string; code: string; used: boolean }[]>(
        "/admin/invitations",
      )
        .then(setInvites)
        .catch((e) => setInviteError(errorText(e)));
  }, [user.id]);
  return (
    <div className="stack">
      <p className="record-heading">
        {user.username}
        {user.is_admin ? " · 站主" : ""}
      </p>
      <h3>修改我的密码</h3>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          if (f.get("new") !== f.get("confirm"))
            return setError("两次新密码不一致");
          setError("");
          onChange(String(f.get("old")), String(f.get("new")));
        }}
      >
        {error && <p className="error">{error}</p>}
        <label>
          当前密码
          <input
            name="old"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          新密码
          <input
            name="new"
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={128}
            required
          />
        </label>
        <label>
          确认新密码
          <input
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
          />
        </label>
        <button disabled={busy}>保存新密码</button>
      </form>
      {user.is_admin && (
        <details className="admin-panel">
          <summary>账户管理</summary>
          <p className="muted">
            朋友使用站主分配的邀请码注册。邀请码通过服务器外置配置维护。
          </p>
          {inviteError && <p className="error">{inviteError}</p>}
          {invites.map((i) => (
            <div className="invitation" key={i.username}>
              <strong>
                {i.username} · {i.used ? "已使用" : "待注册"}
              </strong>
              {!i.used && (
                <>
                  <code>{i.code}</code>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard
                        .writeText(i.code)
                        .catch(() =>
                          setInviteError("复制失败，请手动选择邀请码"),
                        );
                    }}
                  >
                    复制邀请码
                  </button>
                </>
              )}
            </div>
          ))}
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              if (
                window.confirm(
                  "确认重置 " + String(f.get("username")) + " 的密码？",
                )
              )
                onReset(String(f.get("username")), String(f.get("password")));
            }}
          >
            <label>
              需要重置的用户名
              <input name="username" autoComplete="off" required />
            </label>
            <label>
              临时新密码
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={10}
                maxLength={128}
                required
              />
            </label>
            <button disabled={busy}>重置指定账户密码</button>
          </form>
        </details>
      )}
      <button className="danger" disabled={busy} onClick={onLogout}>
        退出登录
      </button>
    </div>
  );
}
