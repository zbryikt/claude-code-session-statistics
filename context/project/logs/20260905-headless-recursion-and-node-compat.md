# claude -p 的自我遞迴，與 Node 版本相容性

兩個在使用中才浮現的問題。


## 摘要會把自己算進去

`claude -p` 預設也會寫下自己的 transcript。那會被下一次掃描當成新 session、
再被摘要一次，於是每跑一輪就多出一批。

實測證據：跑一次 `ccs sum -n 3` 之後 session 數從 115 變成 118，剛好三筆；
列表裡開始出現 `private:tmp` 這種項目。

這不會指數爆炸，但永遠不會收斂 —— `ccs sum -a` 每次都會找到新工作，
`摘要都是最新的` 這個狀態永遠達不到。附帶還污染 token 統計：多出 haiku 的列，
專案欄變成 `/private/tmp`。

處理成兩層。

源頭是 `claude` 的 `--no-session-persistence` ( 只能配 `--print` 用 )，加上去
就完全不留檔，實測 transcript 數 142 到 142 沒變。

防呆是掃描時再認一次 headless 的標記。互動 session 與 headless 的差別很清楚：

    互動    entrypoint: "cli"       promptSource: "typed"
    headless entrypoint: "sdk-cli"  promptSource: "sdk"

認到就標成 `kind='sdk'`，排除在列表與統計之外 ( `--sdk` 可以看 )。這層是為了
已經產生的舊資料，以及可能在別處跑的 headless 呼叫。`ccs sync --rescan` 重新
分類後本機清出 14 筆。

同時修掉一個潛在地雷：`--disallowed-tools` 吃可變長度參數，會把後面的東西一路
當成工具名。原本是靠「prompt 前面剛好隔了另一個旗標」矇混過去，改成用 `--`
明確隔開。


## node:sqlite 的版本斷層

使用者在 Node 22.12.0 上執行時噴 `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`。

`node:sqlite` 在 22.5 加入、22.13 才免旗標，22.12 剛好卡在中間。原本 `engines`
寫 `>=22` 是錯的，改成 `>=22.13`。

但光改 engines 不夠。volta 與 nvm 依當前目錄決定 node 版本，而 `ccs` 是從任何
目錄執行的 —— 在某個 pin 了舊版的專案底下就會拿到不堪用的 node。所以 `bin/ccs`
自己處理，依序：

 - 直接試載，可以就走
 - 不行且版本 >= 22.5 就帶 `--experimental-sqlite` 重跑自己
 - 還是不行就去 volta 與 n 的安裝目錄找一個 >= 22.13 的 node 重跑
 - 都沒有才報錯，並說明怎麼裝

第二步的版本判斷不能省。一開始寫成「先試旗標再看版本」，結果 Node 20 對未知
旗標是硬錯誤，直接以 `bad option: --experimental-sqlite` 中止。

拿機器上實際安裝的舊版驗過：20.17.0 會自動改用 22.23.x，22.12.0 會自動帶旗標，
兩者都正常。Node 14 這種連 ESM 都解析不了的版本不在支援範圍。


## 安裝方式

實際跑過完整流程 ( clone 到 npm i 到 npm link 到執行 )，不是照著推測寫的。

`npm i` 幾乎什麼都不做，因為零相依，只產生 lock 檔。真正要做的是把 `ccs` 放上
PATH，四種方式的實測數字：

 - `npm link` ( clone 後 )：每次執行 0.09 秒，`git pull` 立即生效
 - `npm i -g github:zbryikt/claude-code-session-statistics`：安裝 3.8 秒，執行 0.24 秒
 - `npx -y github:zbryikt/claude-code-session-statistics`：有快取 2.0 秒，首次 4.9 秒
 - `./bin/ccs` 直接跑：0.09 秒

npx 不需要發佈到 npm 也能從 GitHub 跑，但那 2 秒是每次執行都要付的成本，
對一個一天敲很多次的指令太慢，而且需要網路。它適合試用與一次性查詢。

`npm link` 與 `npm i -g` 的差別在會不會改：前者是 symlink 指向 repo，`git pull`
立刻生效；後者安裝的是快照複本，要更新得重跑安裝。所以開發機用 link，
其他只是要用的機器用 `-g`。

意外收穫是 volta 使用者特別受益：`npm link` 之後 volta 建的 shim 會綁定安裝當下
的 node 版本，之後在任何目錄執行都不受該目錄的 node 版本影響。

    $ volta list
    package claude-code-session-statistics@0.3.0 / ccs / node@22.23.1

也就是說 volta 環境靠 shim 就解決了版本問題，`bin/ccs` 裡那層執行期 fallback
是留給沒有版本管理工具的環境。
