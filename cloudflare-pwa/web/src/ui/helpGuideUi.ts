import { openModal } from './helpers';
import {
  APP_VERSION,
  BUILD_COMMIT,
  BUILD_TIME,
  DB_SCHEMA_VERSION,
  SW_CACHE_VERSION,
  VERSION_HIGHLIGHTS,
} from '../version';

export type HelpSectionId =
  | 'savings'
  | 'ledgers'
  | 'stocks'
  | 'savings_link'
  | 'loans'
  | 'sync'
  | 'privacy';

interface HelpBullet {
  lead: string;
  text: string;
}

interface HelpSection {
  id: HelpSectionId;
  title: string;
  formula?: string;
  bullets: HelpBullet[];
}

const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'savings',
    title: '📊 總儲蓄、真實儲蓄率與「稅金攤提」口徑',
    formula: '總儲蓄 ＝ 總收入 − 消費性總支出 ＝ 投資流出（強制儲蓄） ＋ 自由現金流',
    bullets: [
      {
        lead: '為什麼「投資流出」也算總儲蓄？',
        text: '買股票或基金只是把現金轉成投資資產，錢並沒有花掉，因此會計入「總儲蓄」與「真實儲蓄率（總儲蓄 ÷ 總收入）」。',
      },
      {
        lead: '大項統計可點擊展開明細',
        text: '總覽頁的收支大項依記帳類型自動彙整，點擊有箭頭「▸」的項目即可展開各細項分類或稅金分攤明細，不受個人化命名限制。',
      },
      {
        lead: '為什麼每月開頭會是負數，或年度總儲蓄比當月高？',
        text: '「當月視角」採用保守預留口徑：會先把你在「工具 → 稅金分攤」啟用的每月應提撥預備金（例如所得稅、牌照稅、年繳保費 ÷ 12）先扣起來，避免繳稅月大爆表；而「年度累計視角」採實支口徑，只扣今年實際已繳出的稅金／大額支出。在真正繳稅前，兩邊差額正好就是「稅金攤提(月) / 實支(年)」那一列。',
      },
      {
        lead: '如果不想每月先預扣稅金攤提？',
        text: '到「工具 → 稅金分攤」把項目開關停用，每個月就會從 0 開始，當月與年度的總儲蓄也會完全一致。',
      },
      {
        lead: '緊急預備金可支撐月數',
        text: '計算方式為「高流動資產（活存／定存／現金等） ÷ 當月消費性總支出」，用來衡量無收入時可支撐的生活月數。',
      },
    ],
  },
  {
    id: 'ledgers',
    title: '📒 多帳本隔離與獨立帳戶管理',
    bullets: [
      {
        lead: '獨立帳本完全不污染個人總資產',
        text: '點選記帳、總覽、資產或固定收支頁上方的「+ 新帳本 / ⚙ 帳本」即可建立獨立帳本（如代管帳戶、公帳、副業或旅遊專戶）。未勾選「納入個人總資產」的帳本，其活存、資產與流水帳一律與個人總資產、淨值、儲蓄率及月底快照完全隔離。',
      },
      {
        lead: '單一帳本可建立多項資產與活存',
        text: '每個帳本皆可管理多個連動活存與一般資產，並各自擁有獨立的「預設連動活存帳戶」與常態收支自動入帳排程。',
      },
      {
        lead: '單筆資產排除開關',
        text: '即使項目留在個人主帳本，也可以在編輯資產／活存時勾選「單獨不計入個人總資產」，方便彈性排除特定押金或代墊款；切到資產頁「全部合併」視角仍可隨時盤點與編輯。',
      },
    ],
  },
  {
    id: 'stocks',
    title: '📈 持股加碼、觀察清單、今日漲跌與 3D 翻牌卡',
    bullets: [
      {
        lead: '每月定期定額（已有固定排程扣款）',
        text: '請在「工具 → 固定收支」將該筆設為「投資流出」；後續到「持股」補登買入股數與價格時，保持「不勾選」同步寫入流水帳，系統只會更新股數與均價，絕不重複扣款。',
      },
      {
        lead: '額外臨時加碼（逢低多買）',
        text: '在「持股 → 加碼買入」勾選「同步寫入流水帳（投資流出）並扣減活存」，就會一次記帳＋扣活存＋累算均價，免跑記帳頁重記。',
      },
      {
        lead: '帳面價差（不含息）vs 配息扣成本（含息）',
        text: '「不含息」單純看股價相對原始均價的漲跌；「含息」則把歷年領到的現金配息從投入本金中扣除，反映真實未回本金額（歸零即顯示「✓ 已回本」）。',
      },
      {
        lead: '觀察清單與一鍵轉為持股',
        text: '切換至持股頁「觀察清單」分頁可追蹤尚未買進的台美標的，系統會同步更新收盤價、昨收價與今日漲跌（依你的正負配色方案上色），但嚴格不計入持股總市值與個人總資產；實際買進時可點「轉為持股」無縫建倉。',
      },
      {
        lead: '3D 翻牌卡與行情更新時間',
        text: '可在持股／觀察清單右側切換「列表 / 翻牌卡」模式：正面看現價、昨收、今日漲跌與市值；點擊卡片翻至背面即可檢視均價、含息報酬、配息回本進度、最後更新時間與操作按鈕。',
      },
      {
        lead: '持股分類與多樣化圖表',
        text: '可為每檔持股標記「個股 / ETF / 特別股」或自訂分類（如債券 ETF、高股息），並切換甜甜圈、圓餅圖、長條圖、面積圖檢視「市值佔比 / 持股分類 / 成本佔比 / 台美市場」。',
      },
      {
        lead: '台股與美股自動行情同步',
        text: '填入股票代碼即可自動更新收盤價與昨收價：台股支援 2330 / 0050 / 00679B / TPE:0050（含上市與上櫃債券 ETF）；美股支援 VOO / NVDA / AAPL / BRK.B / NASDAQ:TSLA（Yahoo Finance ＋ Stooq 雙備援，免費免 API Key）。',
      },
    ],
  },
  {
    id: 'savings_link',
    title: '🏦 活存帳戶即時連動與對帳校準',
    formula: '目前活存 ＝ 基準日餘額 ＋ 存轉調整（本金移轉） ＋ 連動流水帳淨額',
    bullets: [
      {
        lead: '存轉調整不會扭曲儲蓄率',
        text: '不同銀行間轉帳、領現或存入既有存款屬於本金移轉而非當月收入／支出，請從資產頁活存卡片點「存入／轉出」記錄，不影響損益報表。',
      },
      {
        lead: '帳戶互轉（活存 ↔ 活存 / 定存）與轉帳手續費',
        text: '點選「⇄ 帳戶互轉」可一次從 A 帳戶轉出並入帳到 B 帳戶（支援活存與定存／現金互轉、跨幣別換匯與跨帳本轉帳），本金移轉不會計入當月收支與儲蓄率；若有填寫轉帳手續費，僅手續費會自動扣款並記為一筆支出。活存互轉若誤記刪除，會自動提示同步撤銷對方帳戶紀錄。',
      },
      {
        lead: '對帳校準（基準日防呆）',
        text: '若因銀行利息或漏記幾筆零錢造成些微落差，點「對帳校準」填入網銀實際餘額即可重設基準點，基準日以前的舊帳不會重複扣算。',
      },
    ],
  },
  {
    id: 'loans',
    title: '🏠 貸款自動還本推算與快照校準',
    bullets: [
      {
        lead: '免跑銀行掌握預估剩餘本金',
        text: '房貸／車貸填入基準日餘額、年利率、月付金與扣款日後，系統會按月以本息均攤自動推算已還本金、已付利息與預估剩餘餘額，並可展開未來還款試算表。',
      },
      {
        lead: '不知道利率也能反推',
        text: '編輯貸款時可點「反推年利率」小工具，輸入原始申貸日與貸款年限即可自動回推年利率（支援小數點後三位）。',
      },
      {
        lead: '隨時保留手動快照更新',
        text: '實際查詢銀行餘額後，點「快照校準」即可直接覆蓋最新餘額，也能隨時關閉自動推算切回純手動快照。',
      },
    ],
  },
  {
    id: 'sync',
    title: '☁ 離線優先同步與版本衝突保護',
    bullets: [
      {
        lead: '0ms 離線秒開秒記帳',
        text: '所有資料皆保存在本機 IndexedDB，飛航模式或無網路時一樣可完整查帳、記帳，連網後自動背景雙向同步。',
      },
      {
        lead: '樂觀鎖版號防覆蓋',
        text: '每筆紀錄皆由伺服器發放遞增版號（version）。兩台裝置各自編輯「不同筆」會自動無感合併；若同時離線改到「同一筆」，頂部會顯示「⚠ 衝突 (N)」，點擊可逐欄對照差異，自行決定「採用雲端最新版」或「保留本機離線版」，絕不靜默蓋掉資料。',
      },
    ],
  },
  {
    id: 'privacy',
    title: '🔒 家庭多帳號隔離、快速解鎖與忘記密碼',
    bullets: [
      {
        lead: '成員間 100% 獨立隔離',
        text: '每位成員擁有獨立的雲端帳本與本機資料庫，彼此完全看不到對方資料；管理員也僅能管理帳號啟用、邀請碼與重置碼，無法檢視任何成員的帳目與密碼。',
      },
      {
        lead: '日常解鎖最順手設定',
        text: 'iOS 網頁版呼叫 Passkey 受系統限制必彈確認視窗；建議把 Passkey 留作「免填帳號一鍵登入」，日常鎖屏可改開「4～6 碼 PIN（輸入正確即秒解鎖，免按確認）」，或依個人習慣關閉啟動鎖。',
      },
      {
        lead: '忘記密碼處理（零知情重置）',
        text: '請管理員於「家庭成員與邀請碼」產生一次性重置碼連結傳給你，由你本人自行設定新密碼；舊裝置會立即強制登出，管理員全程無法得知你的密碼。',
      },
    ],
  },
];

function formatBuildTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function openHelpGuideModal(focusSection?: HelpSectionId): void {
  const body = openModal('使用指南與計算口徑說明');

  const intro = document.createElement('div');
  intro.className = 'help-intro';
  intro.textContent =
    '這裡整理了系統各項報表公式、記帳防重複原則與離線同步機制，隨時點擊展開即可查閱（離線皆可瀏覽）。';
  body.appendChild(intro);

  const list = document.createElement('div');
  list.className = 'help-list';

  let focusedEl: HTMLDetailsElement | null = null;

  for (const sec of HELP_SECTIONS) {
    const details = document.createElement('details');
    details.className = 'help-item';
    if (focusSection ? sec.id === focusSection : sec.id === 'savings') {
      details.open = true;
      if (focusSection === sec.id) {
        focusedEl = details;
      }
    }

    const summary = document.createElement('summary');
    summary.className = 'help-summary';
    summary.textContent = sec.title;
    details.appendChild(summary);

    const content = document.createElement('div');
    content.className = 'help-content';

    if (sec.formula) {
      const f = document.createElement('div');
      f.className = 'help-formula tnum';
      f.textContent = sec.formula;
      content.appendChild(f);
    }

    const ul = document.createElement('ul');
    ul.className = 'help-bullets';
    for (const b of sec.bullets) {
      const li = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = b.lead + '：';
      li.appendChild(strong);
      li.appendChild(document.createTextNode(b.text));
      ul.appendChild(li);
    }
    content.appendChild(ul);
    details.appendChild(content);
    list.appendChild(details);
  }

  body.appendChild(list);

  // Version & system info card
  const verCard = document.createElement('div');
  verCard.className = 'help-version-card';

  const verHead = document.createElement('div');
  verHead.className = 'help-version-head';
  const verTitle = document.createElement('span');
  verTitle.className = 'help-version-title';
  verTitle.textContent = '目前版本資訊';
  const verBadge = document.createElement('span');
  verBadge.className = 'badge tnum';
  verBadge.style.marginRight = '0';
  verBadge.textContent = `v${APP_VERSION}`;
  verHead.appendChild(verTitle);
  verHead.appendChild(verBadge);
  verCard.appendChild(verHead);

  const verGrid = document.createElement('div');
  verGrid.className = 'help-version-grid tnum';
  const metaRows: Array<[string, string]> = [
    ['建置編號', BUILD_COMMIT],
    ['建置時間', formatBuildTime(BUILD_TIME)],
    ['資料庫 Schema', `v${DB_SCHEMA_VERSION}`],
    ['離線快取', SW_CACHE_VERSION],
  ];
  for (const [k, v] of metaRows) {
    const cell = document.createElement('div');
    cell.className = 'help-version-cell';
    const kl = document.createElement('span');
    kl.className = 'help-version-k';
    kl.textContent = k;
    const vl = document.createElement('span');
    vl.className = 'help-version-v';
    vl.textContent = v;
    cell.appendChild(kl);
    cell.appendChild(vl);
    verGrid.appendChild(cell);
  }
  verCard.appendChild(verGrid);

  const changelog = document.createElement('details');
  changelog.className = 'help-changelog';
  const clSum = document.createElement('summary');
  clSum.textContent = '版本更新紀錄';
  changelog.appendChild(clSum);

  const relUl = document.createElement('ul');
  relUl.className = 'help-bullets';
  relUl.style.marginTop = '6px';
  for (const line of VERSION_HIGHLIGHTS) {
    const li = document.createElement('li');
    const sepIdx = line.indexOf('：');
    if (sepIdx > 0) {
      const strong = document.createElement('strong');
      strong.textContent = line.slice(0, sepIdx + 1);
      li.appendChild(strong);
      li.appendChild(document.createTextNode(line.slice(sepIdx + 1)));
    } else {
      li.textContent = line;
    }
    relUl.appendChild(li);
  }
  changelog.appendChild(relUl);
  verCard.appendChild(changelog);
  body.appendChild(verCard);

  if (focusedEl) {
    requestAnimationFrame(() => {
      focusedEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }
}
