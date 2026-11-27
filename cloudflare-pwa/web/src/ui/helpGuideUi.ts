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
  | 'start'
  | 'savings'
  | 'ledgers'
  | 'recurring'
  | 'credit'
  | 'splits'
  | 'goals'
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
    id: 'start',
    title: '快速上手',
    bullets: [
      {
        lead: '先設定帳本與帳戶',
        text: '在「資產」新增活存、定存、現金或信用卡。活存可填入銀行實際餘額與基準日，也可設為該帳本的預設連動帳戶。',
      },
      {
        lead: '記第一筆流水',
        text: '在「記帳」確認帳本、日期與幣別，再輸入類型、分類、項目和金額。選擇連動帳戶後，同一筆流水也會反映在帳戶餘額。',
      },
      {
        lead: '查找舊帳與重複記帳',
        text: '流水帳可依關鍵字、日期、類型、分類、金額、連動帳戶與帳本範圍篩選，並匯出可備份的篩選結果。常用項目可儲存範本，下次套用或一鍵直記。已失效的綁定須先更新範本才能一鍵直記。',
      },
    ],
  },
  {
    id: 'ledgers',
    title: '個人帳本與共同帳本',
    bullets: [
      {
        lead: '分開管理並選擇統計範圍',
        text: '從帳本選單開啟「多帳本管理」，可為旅遊、家庭開支或副業建立帳本。個人主帳本固定計入淨值。其他帳本可選擇是否納入個人總資產與淨值統計，也可在資產頁單獨排除指定項目。',
      },
      {
        lead: '分享或加入帳本',
        text: '在「多帳本管理」點自建帳本旁的「共用」，選擇權限與有效天數，產生一次性邀請碼。已註冊的對方可開啟邀請連結，或從「加入帳本」輸入邀請碼。預設個人主帳本無法分享。',
      },
      {
        lead: '權限與淨值偏好',
        text: '擁有者可管理邀請與成員。可編輯成員能協作記帳和管理共同帳本內的紀錄，僅檢視成員可查閱資料。加入的帳本預設不納入個人淨值，可從該帳本的「設定」自行調整。',
      },
      {
        lead: '共同帳本內的連動',
        text: '共同流水、固定收支、拆帳與分期應連動同一共同帳本內的帳戶。舊紀錄若仍連動帳本外的有效帳戶，只有擁有者可編輯或刪除，建議分享前先檢查並調整。退出或遭移除後，下次同步會清除本機上的該帳本資料與未送出的異動。',
      },
    ],
  },
  {
    id: 'savings',
    title: '總覽、儲蓄率與稅金攤提',
    formula: '總儲蓄 ＝ 總收入 − 消費性總支出 ＝ 投資流出 ＋ 自由現金流',
    bullets: [
      {
        lead: '真實儲蓄率',
        text: '總儲蓄除以總收入。投資流出代表現金轉為投資資產，會從自由現金流扣除，仍計入總儲蓄。點總覽有箭頭的大項即可展開明細。',
      },
      {
        lead: '當月攤提與年度實支',
        text: '當月視角採用「工具 → 大額攤提」中該月在期間內的每月預留金額，所以月初可能先顯示負數。年度累計採用已記錄的稅金與大額實支。設定開始月份後，攤提只在開始月起算的「月數」內計入，期滿自動結束；選「每年重複」則每年從開始月份再算一輪。沒有開始月份的舊項目維持每月計入，停用前不會結束。',
      },
      {
        lead: '緊急預備金',
        text: '可支撐月數為高流動資產除以當月消費性總支出。信用卡額度不屬於高流動資產。',
      },
      {
        lead: '淨資產歷史',
        text: '在「資產」查看月底淨資產走勢與資產結構，可切換近 12 個月或全部期間，並選取單月查看明細。',
      },
    ],
  },
  {
    id: 'recurring',
    title: '固定收支、幣別與工具',
    bullets: [
      {
        lead: '固定收支的入帳日',
        text: '到「工具 → 固定收支」設定週期、連動帳戶與每月入帳日。若當月沒有指定日期，就以月底入帳。記帳時勾選「設為每月固定自動入帳」會同時建立固定收支項目，沿用該筆流水的日期作為入帳日。',
      },
      {
        lead: '手動補入帳',
        text: '連線時可在「固定收支」點「立即入帳本月」，確認畫面所選年月後執行。已入帳的項目會略過。請先確認固定收支設定已同步。',
      },
      {
        lead: '多幣別與匯率',
        text: '點上方匯率膠囊可選擇啟用幣別、調整匯率或切換自動更新。資產與報表會依幣別換算為台幣，跨幣別轉帳可填入實際轉出與到帳金額。',
      },
      {
        lead: '計算機與水電分攤',
        text: '懸浮計算機可把算式結果帶回金額等欄位。有水電分攤權限的帳號可在「工具」輸入本期度數與帳單，查看分攤、租金合計及歷史紀錄。',
      },
    ],
  },
  {
    id: 'savings_link',
    title: '活存、帳戶互轉與對帳',
    formula: '目前活存 ＝ 基準日餘額 ＋ 基準後的存轉調整 ＋ 基準後的連動流水淨額',
    bullets: [
      {
        lead: '存入、轉出與互轉',
        text: '本金移轉可在活存卡片使用「存入／轉出」，或用「帳戶互轉」成對登記活存、定存或現金帳戶的增減。只有另外填寫的轉帳手續費會列入支出。涉及共同帳本的互轉限同一共同帳本。撤銷成對的活存互轉時，畫面會提示一併撤銷對方帳戶的紀錄。',
      },
      {
        lead: '餘額與銀行不符',
        text: '使用「對帳校準」輸入銀行實際餘額與日期，讓系統從新基準計算後續變動。已包含在基準餘額中的舊帳不會再加扣。',
      },
    ],
  },
  {
    id: 'credit',
    title: '信用卡帳單與分期付款',
    bullets: [
      {
        lead: '刷卡與繳卡費',
        text: '在「資產 → 信用卡與分期付款」新增卡片並設定結帳日、繳款日與額度。記帳選信用卡時，消費會計入預算並增加卡片未繳金額。繳款時從卡片點「繳卡費」，同時扣減付款帳戶並沖銷卡片餘額，避免再記一次消費。',
      },
      {
        lead: '查看帳單與對帳',
        text: '卡片會區分已出帳未繳與未出帳金額。用「對帳校準」輸入實際未繳餘額後，同日已納入校準的刷卡會略過重算。',
      },
      {
        lead: '建立分期與補入帳',
        text: '用「＋分期」設定信用卡、總額、期數、起始月及入帳日。系統按期入帳，亦可在分期區手動補入到期未入帳的期數。已入帳的計畫無法再改總額或期數，剩餘期數可用「提前清償」一次入帳。',
      },
    ],
  },
  {
    id: 'splits',
    title: '代墊與拆帳應收',
    bullets: [
      {
        lead: '先付款再向他人收回',
        text: '在「記帳」使用「拆帳」，填寫實付金額、付款帳戶及各人的分攤額。付款帳戶扣除全額，流水只計入自己應負擔的支出，其餘列為應收。',
      },
      {
        lead: '收回或免還',
        text: '到「資產 → 代墊款與拆帳應收」選「收回入帳」，可部分或全額收回，並指定入帳帳戶。確定不再收取時，可用「免還轉支出」認列剩餘金額，付款帳戶不會再次扣款。',
      },
    ],
  },
  {
    id: 'stocks',
    title: '持股、觀察清單與再平衡',
    bullets: [
      {
        lead: '買入與記帳只做一次',
        text: '定期定額已由「固定收支」記為投資流出時，補登持股只需更新股數與成交價。臨時加碼可在買入時勾選同步寫入流水帳，讓系統一併記錄投資流出及扣減選取的活存。',
      },
      {
        lead: '報價、成本與配息',
        text: '填入支援的股票代碼可更新現價與昨收，畫面會顯示報價更新時間。不含息報酬以買入成本計算，含息口徑也納入已記錄的配息。可在配息月曆查閱年度分布及消費覆蓋率。',
      },
      {
        lead: '觀察與配置',
        text: '觀察清單可追蹤標的報價，買入後可轉為持股。觀察項目不計入資產與投資組合。持股可自訂分類，並以列表、翻牌或圖表檢視。可依分類或標的設定再平衡目標，試算只買不賣或買賣調倉金額。',
      },
    ],
  },
  {
    id: 'goals',
    title: '財務目標與達成推估',
    bullets: [
      {
        lead: '選擇追蹤範圍',
        text: '在「總覽 → 財務目標與達成推估」新增目標，可依總淨資產、FIRE 財務自由、帳本、指定資產組合或手動存錢桶追蹤進度。',
      },
      {
        lead: '試算達成月份',
        text: '系統依設定的每月投入與預期年化報酬估算達成時間。每月投入留空時，採近 12 個月內可用的平均月儲蓄。若填入期望達成日，也可反推每月應存金額。實際收入、存款與報酬改變時，估算會隨之變動。',
      },
    ],
  },
  {
    id: 'loans',
    title: '貸款自動試算與快照校準',
    bullets: [
      {
        lead: '估算剩餘本金',
        text: '為房貸或車貸填入基準日餘額、年利率、月付金及扣款日，系統會按本息均攤估算剩餘本金與利息。可開啟「攤還試算表」查看後續期數。',
      },
      {
        lead: '利率未知或銀行餘額有差',
        text: '用「反推年利率」依貸款資料試算，或透過「快照校準」以向銀行查到的實際本金重設基準。也可關閉自動推算，改為手動更新餘額。',
      },
    ],
  },
  {
    id: 'sync',
    title: '離線記帳、同步與備份',
    bullets: [
      {
        lead: '離線前先登入並同步',
        text: '已在此裝置登入並載入的資料可離線查看和編輯。連線後會同步待送紀錄，也可點頂部同步狀態手動同步。邀請、加入帳本和更新行情需要網路。',
      },
      {
        lead: '處理衝突與還原後的異動',
        text: '同一筆資料在多部裝置上改動時，可從同步提示查看差異並決定保留哪個版本。若雲端經覆蓋還原，還原前待送異動會暫停上傳，可從提示檢視後捨棄或重新套用。共同帳本只凍結受影響帳本的異動。',
      },
      {
        lead: '匯出與還原',
        text: '到「帳號、顯示與安全設定」匯出完整 JSON 或流水帳 CSV，或匯入原 Google Sheets 的 CSV。「從 JSON 備份檔還原」會合併備份內容。匯入含自己共同帳本的備份時，畫面會提醒你確認，因為備份可能覆寫同一筆紀錄的新修改。JSON 與流水帳 CSV 都可包含自己擁有的共同帳本，會排除加入的他人帳本。',
      },
    ],
  },
  {
    id: 'privacy',
    title: '帳號隱私、解鎖與密碼重設',
    bullets: [
      {
        lead: '帳號與資料權限',
        text: '個人帳目限本人帳號查閱。共同帳本依成員權限開放資料。家庭管理員負責帳號狀態、註冊邀請與密碼重置。',
      },
      {
        lead: 'Passkey 與離線 PIN',
        text: '可在安全設定綁定 Passkey 以快速登入，並設定 4～6 位 PIN 解鎖此裝置。若裝置無法離線驗證 Passkey，可使用 PIN 解鎖。',
      },
      {
        lead: '重設密碼與登出',
        text: '忘記密碼時，請管理員提供一次性重置碼，由本人設定新密碼。重設會使既有登入失效並清除已設定的 Passkey 與 PIN。登出會清除這台裝置的本機帳本資料，請先確認待送紀錄已同步。',
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
    '依主題展開查看操作步驟與計算方式。指南可離線查閱。';
  body.appendChild(intro);

  const list = document.createElement('div');
  list.className = 'help-list';

  let focusedEl: HTMLDetailsElement | null = null;

  for (const sec of HELP_SECTIONS) {
    const details = document.createElement('details');
    details.className = 'help-item';
    if (focusSection ? sec.id === focusSection : sec.id === 'start') {
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
    ['離線快取', `${SW_CACHE_VERSION}（每次建置自動更新）`],
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
