# 路徑摘要、可切換欄位與寬度對齊

需求是讓列表能顯示更精簡的路徑版本，並且各欄位可以自由開關與排序。


## 路徑摘要：歸納後發現不需要 LLM

原本的想法是在跑摘要時順便請模型把路徑也摘要一份。實際把資料庫裡 70 個不同的
`cwd` 拉出來歸納之後，結論是規則就夠了：

    ~/workspace/<scope>/<kind>/<name>     kind 有 projects(19) boards(11) blocks(4) case
    ~/workspace/<scope>/<name>
    ~/ai/<year>/<MMDD>-<topic>
    ~/ai/topics/<topic>

關鍵發現是 `projects` / `boards` / `blocks` 這些第三層是組織用的分類詞，不帶識別
資訊，顯示時略過就得到簡明版本：

    ~/workspace/plotdb/projects/esh          ->  plotdb:esh
    ~/workspace/grantdash/boards/itma-2026   ->  grantdash:itma-2026
    ~/workspace/makeform/blocks/richtext     ->  makeform:richtext
    ~/ai/2026/0901-tinypng                   ->  ai:0901 tinypng
    ~/ai/topics/cpu                          ->  ai:cpu

70 個路徑規則涵蓋 66 個，其餘 ( `~/Dropbox/...`、`/private/tmp` ) 退回「最後兩段」
也堪用。

用規則勝過 LLM 的地方是同一路徑永遠得到同一標籤。這是一個要用眼睛掃的欄位，
措辭每次跑都浮動比不夠聰明更礙事；附帶好處是零成本、零延遲。


## 深層路徑要保留首尾，不能只留首段

第一版對更深的層級用省略號表示，驗證時發現會撞名：

    case/taicca/movie                  ->  plotdb:taicca…
    case/taicca/2026/activity-crawler  ->  plotdb:taicca…     同一個標籤

改成保留首尾兩段 ( `plotdb:taicca/movie` 與 `plotdb:taicca/activity-crawler` )
之後，70 個路徑零碰撞。


## 欄位開關

`-c` 後接編號，列到的才顯示。`#` 與 `STATUS` 固定顯示。

 - 1 是閒置時間
 - 2 是完整路徑
 - 3 是路徑摘要
 - 4 是最後 prompt
 - 5 是內容摘要

預設 `-c134`。欄寬依終端機寬度自動分配：固定欄位先扣掉，剩下的由 `LAST PROMPT`
與 `SUMMARY` 平分，只有一個時獨佔。

原本 `-s` 是 `--summary` 的縮寫，與排序語法衝突，所以摘要改由 `-c5` 控制。


## 排序

`-s` 後接欄位編號，`+` 正序、`-` 逆序 ( 預設逆序 )。不給 `-s` 時是預設排序：
執行中的排前面，其餘依時間新到舊；給了 `-s` 就純粹照該欄排，不再把執行中的
挑到前面。

`-c` 與 `-s` 這種黏在一起的短旗標 `node:util` 的 `parseArgs` 處理不了，所以在
交給它之前先自行抽出來，順便做範圍檢查給出清楚的錯誤訊息。


## 兩個寬度計算的 bug

排版歪掉查下去是兩個獨立問題。

第一個是 `width()` 用 `> 0x2E80` 判斷太粗，把「東亞模糊寬度」字元 ( `…` `●`
`↳` `—` ) 全算成兩格，但終端機只給一格。改用明確的寬字元範圍表。

第二個是 `trunc()` 截斷時直接 `out + '…'`，沒有為省略號預留空間。當內容剛好
填滿目標寬度時，結果會比目標寬一格。這個特別隱蔽 —— 只有截斷位置剛好對齊時
才發作，所以有些列正常、有些差一格。修法是先退到放得下省略號為止再接上。

補了寬度不變式的測試：`width(pad(trunc(s, n), n)) === n`，各種中英混排都過。


## 統計表：同樣的問題與同樣的撞名

統計表的靠右對齊用了 `String.padStart`，它數的是 UTF-16 字元數而非顯示寬度，
`'訊息'.padStart(9)` 得到 9 個字元但佔 11 格，中文表頭就歪了。補了寬度感知的
`lpad()`，三個表改成欄位規格驅動 ( `renderTable` )，共用同一套對齊邏輯。

更嚴重的是專案欄用 `cwd` 最後一段分組，那會撞名並且把不同專案的用量加在一起：

    修正前            修正後
    servebase   7  ->  plotdb:servebase           6
                       servebase:suite            1     本來被併進去
    judge       5  ->  taiccadash:esg-2026/judge  4     橫跨多個 board 的被混算
    server      4  ->  makechart:server           4

這是正確性問題不是美觀問題，先前看到的數字是錯的。`sessions` 加了 `label` 欄位
在掃描時算好，統計直接 `GROUP BY label`。

順帶踩到：`CREATE INDEX` 建在新欄位上會排在 migrate 之前執行，舊資料庫會噴
`no such column: label`。把索引從 schema 拆出來，排在遷移之後才建。

改過分組規則需要重掃，加了 `ccs sync --rescan`。
