# Finance screens: build spec

This is the hand-off for the screens of the `finance` module. The engine is
done: **183 routes**, every one tested through the API functions
(`finance.test.ts`, `close.test.ts`, `business.test.ts`, `trade.test.ts`).
The screens are not built yet. This file says what each screen holds, which
route feeds it, which route each form posts to, and what to watch for, so
that whoever builds them (a person or another AI) can work page by page
without re-reading the engine.

**Status, 2026-10-04**

| Piece | State |
|---|---|
| `api/*` (engine), `routes.ts` (183 routes), `api/openapi.ts` | done, tested |
| `pages.ts`: `/`, `/journal`, `/accounts`, `/periods`, `/budgets` | live: the old v0.3 screens, still correct |
| `screens/kit.ts`: roles, `choices()`, `docRecord()`, `fc()`, `qty()`, `pick()` | written, not wired |
| `screens/home.ts`: the new `/` workspace and `/my` | written, not wired |
| Everything else in this file | **to build** |

**How to pick it up**

1. Write one file per area under `screens/` (`setup.ts`, `selling.ts`,
   `payments.ts`, `stock.ts`, `buying.ts`, `assets.ts`, `bank.ts`,
   `reports.ts`). Each exports a `PluginPage[]`.
2. Replace `pages.ts` with an aggregator:
   `export const pages = [...homePages, ...setupPages, ...]`. The new
   `homePages` `/` replaces the old `/`. Keep the old `/journal`, `/periods`
   and `/budgets` pages, or fold them into `setup.ts`. Keep the old
   `/accounts` page, or replace it with the richer one in §B1.
3. Update `manifest.ts`:
   - `navEntries`: one per menu group (§0.4).
   - `rolesWithAccess`: add `hod`, `faculty`, `library_staff` and
     `hostel_staff`, because staff raise material requests.
4. Typecheck: `npx tsc --noEmit -p tsconfig.json` in this package. Run the
   finance tests again.
5. In `campusos-web`, run
   `CAMPUSOS_PLATFORM_DIR=../campusos-platform pnpm core:fetch`. Then open
   each page: `pnpm dev`, sign in as an admin of the demo institution, and go
   to `/m/finance/...`.

Nothing in the engine needs to change to build these screens. Where a screen
wanted something the engine did not offer, the engine was given it:
`GET /approvals/pending` and the `next` paths below are examples.

---

## 0. Ground rules

### 0.1 The page vocabulary

Pages are declarative: see `packages/module-framework/src/pages.ts`. A page
is `{ path, title, roles, menu?, load(actor, req), sections(data), record?(data) }`.

**Section kinds**

- `table` (with the options in §0.5)
- `form`: POST to a route, or GET to filter a page (§0.3)
- `note`
- `prose`
- `figures`
- `links`: tabs, such as status filters
- `kanban`
- `shortcuts`
- `chart` (bar or line)

**Cell kinds**

- `text`
- `code`
- `money`: integer minor units, base currency
- `date`
- `when`
- `days`
- `bool`
- `status`: a coloured badge

**Field kinds**

- Plain inputs: `text`, `number` (with `step: 'any'` for decimals), `date`,
  `datetime`, `textarea` and `hidden`.
- `money`: a decimal string typed by a person.
- `select`: options fixed, or a data key holding `{value,label}[]`.
- `radio`, `checkbox` and `checkboxes`.
- `file`: posted as `{name,type,size,base64}`.
- `lines`: a grid. `columns` holds the row fields. `value` names a data key
  with existing rows (strings). `lineCount` sets the number of empty rows.

`record(data)` turns a page into a **form view**: the sections render in the
main column, beside a sidebar. The sidebar shows the facts, the status, the
audit timeline and the docstatus buttons.

### 0.2 How the host posts a form

- A **checkbox** posts `"true"`/`"false"`. Every boolean in the finance
  schemas is `z.preprocess(ticked, z.boolean())`, so this just works.
- **Empty inputs are left out**, and every optional schema field treats a
  blank as absent.
- **Money and quantities post as typed strings**, for example `"1180.50"`
  and `"2.5"`. The engine parses them:
  - money in the document currency's minor units (`minorUnitsOf`);
  - quantities in milli-units, so `"2.5"` becomes `2500`.

  **Never** send paise from a form. The engine's `*Paise`/`*Fc`/`*Milli`
  fields are outputs.
- **A `lines` grid** posts `lines.0.itemId`, `lines.0.qty`, and so on.
  The host folds these into `lines: [{itemId, qty}]` with `foldLines`, and
  leaves wholly blank rows out.
- **A `file` field** arrives as `{name,type,size,base64}`. Only the bank
  statement import uses one (§I2).
- **An answer** carrying `notice` shows once. One carrying `next` (a
  `/m/finance/...` path) sends the reader there. The engine already returns
  `next` for every create, submit or amend that has a page of its own (§0.6).
- **The docstatus buttons** in a record's head post `{ [idField]: id }`:
  - to the record's `submit` path while it is a draft;
  - to `cancel` while it is submitted. The host adds a required `reason`
    input, and every finance cancel requires `reason` of at least 5 characters;
  - to `amend` once it is cancelled.

  Use `docRecord()` in `screens/kit.ts`, which wires all of this.

### 0.3 GET filter forms (new in this phase)

`PluginForm.method: 'GET'` makes a form a **filter**:
- its `path` is a module page (`/reports/aging`), not a route;
- its fields become that page's query string;
- it is always inline.

Every report, and every list with a party, period or status filter, uses one.
The page's `load(actor, req)` reads the query with `q(req)` from `kit.ts`, and
passes it to the API function. Give each field `value` set to the current
query value, so the filter shows what is applied.

### 0.4 Menu groups and roles

**Roles** (from `kit.ts`, same as `api/core.ts`):

- `OFFICE` = `institution_admin`, `super_admin` and `accounts_staff`. They
  read everything and operate the books.
- `ADMIN` = `institution_admin` and `super_admin`. They configure: the chart,
  settings, taxes, series, approval rules, staff jobs, warehouses, UoMs,
  item groups, asset categories and bank accounts.
- `STAFF` = `OFFICE` plus `hod`, `faculty`, `library_staff` and
  `hostel_staff`. They may raise material requests, see the approvals they
  can give, and, if given a job (capability), do more.
- **Capabilities** are granted on `/staff`. They are checked by the engine,
  not by the page:
  - `storekeeper` may do stock entries and issue against requests;
  - `purchaser` may draft POs from requests;
  - `approver` may approve where a rule names `approver`.

  A page shown to `STAFF` must therefore expect a 403 refusal for some
  readers, and the host shows that refusal.

**Menu groups.** Set `menu` on each page and add a `navEntries` item per group.

| Menu | Pages (landing first) | Roles |
|---|---|---|
| Home | `/` | OFFICE |
| Selling | `/invoices?kind=sales`, `/orders?kind=quotation`, `/orders?kind=sales_order`, `/receipts?kind=delivery_note`, `/recurring`, `/parties?side=customer` | OFFICE |
| Buying | `/invoices?kind=purchase`, `/orders?kind=purchase_order`, `/receipts?kind=purchase_receipt`, `/material-requests`, `/rfqs`, `/supplier-quotations`, `/commitments`, `/parties?side=supplier` | OFFICE (material requests: STAFF) |
| Money | `/payments`, `/vouchers`, `/bank`, `/bank-rules` | OFFICE |
| Stock | `/items`, `/stock-entries`, `/warehouses`, `/stock/balance`, `/stock/ledger`, `/stock/reorder`, `/stock/expiry`, `/stock/serials`, `/batches` | OFFICE plus storekeepers |
| Assets | `/assets`, `/depreciation`, `/assets/maintenance`, `/asset-categories` | OFFICE |
| Reports | `/reports` | OFFICE |
| Setup | `/settings`, `/accounts`, `/periods`, `/budgets`, `/cost-centers`, `/funds`, `/currencies`, `/taxes`, `/series`, `/approval-rules`, `/staff`, `/uoms`, `/item-groups`, `/journal` | ADMIN (read: OFFICE) |
| (staff) | `/my`, `/approvals` | STAFF |

### 0.5 Table options added this phase

All of these are in `PluginTable` and `PluginColumn`, and rendered by
`campusos-web/components/plugin-page.tsx`:

- `column.indent: '<rowKey>'`: indents a cell by the row's depth (0, 1, 2…).
  Use it for every tree: the chart, the statements, the cost centres.
- `table.emphasis: '<rowKey>'`: shows a row in bold when that key is truthy
  (groups, subtotals).
- `table.footer: '<dataKey>'`: one totals row under the table, outside paging.
- `table.fixedOrder: true`: no sort and no filter. Use it where order is
  meaning: statements, ledgers with running balances.

### 0.6 URL scheme (the engine's `next` paths already use it)

For every document, `X` is one of `invoice`, `order`, `receipt`, `payment`,
`voucher`, `stock-entry`, `material-request`, `rfq`, `asset`, `party`,
`item` and `bank-account`:

| Page | Path | What it shows |
|---|---|---|
| List | `/Xs` (plural) | filters as query, for example `/invoices?kind=sales&status=overdue` |
| New | `/X/new` | prefill as query, for example `/invoice/new?kind=purchase&partyId=…` |
| Record | `/X?id=<uuid>` | a draft shows its edit form plus submit; a submitted one shows the view plus its actions; a cancelled one shows amend |

The list's row link is `/m/finance/X?id={id}`.

### 0.7 Display rules

- Base-currency money comes as `*Paise`: use `kind: 'money'`.
- Document-currency money comes as `*Fc`, with the document's `currency`.
  Format it with `fc(minor, currency, minorUnits)` from `kit.ts`, and show
  it as text. The `money` cell kind assumes base currency.
- Quantities come as `*Milli`: format them with `qty(milli, uom)`.
- Rates as strings (`exchangeRate`) are shown as they are.
- Basis points (`rateBp`, `discountBp`, `residualBp`) are divided by 100
  for %.
- Docstatus colours (in `docRecord`): draft gray, submitted blue, cancelled red.
- Invoice `status` values:
  - `draft` gray, `cancelled` red, `return` violet;
  - `paid` green, `partly_paid` orange, `unpaid` blue, `overdue` red.

  The list filter `status=open` means unpaid, partly paid or overdue.
- Order `status` values:
  - `draft`, `cancelled`, `closed`, `completed`;
  - `to_receive_and_bill`, `to_receive`, `to_deliver_and_bill`,
    `to_deliver`, `to_bill`;
  - `open` (a quotation not yet ordered), `ordered` (a quotation turned into
    an order), `expired`.

### 0.8 Choices for selects

`choices(actor)` in `kit.ts` reads every option list in one transaction:

- parties: `customers`, `suppliers` and `parties`;
- items: `items`, `stockItems` and `assetItems`;
- accounts: `accounts` (leaves), `expenseAccounts`, `incomeAccounts`,
  `cashBank` and `groups` (group codes);
- tax: `taxes` and `tds`;
- `warehouses`, `costCenters` (value = code), `funds`, `currencies`,
  `categories` (asset), `staff`;
- plus `baseCurrency` and `stateCode`.

Spread it into the page's `load` result, `{ ...(await choices(actor)), ... }`,
and name the key in a select's `options`. Option values are what the schemas
want: ids, except cost centres (code) and currencies (code).

---

## A. Workspace

### A1. `/` Home: **built** (`screens/home.ts`)
- **Load:** `dashboard(actor)` (`GET /reports/...` is not needed; call the
  function).
- **Sections:**
  - figures: cash and bank, owed to us, we owe, surplus or deficit;
  - "Waiting" shortcuts with counts: draft invoices, overdue customers, bills
    due, unmatched bank lines, material requests, reorder, depreciation due,
    recurring due;
  - a monthly I&E bar chart;
  - "Do" and "Read" shortcut groups.
- Every link in it points at a page in this file. Build those pages and the
  links come alive.

### A2. `/my` Stores and purchasing for staff: **built**
- Two shortcuts: new material request, and my requests.

### A3. `/approvals` Approvals waiting (STAFF)
- **Load:** `GET /approvals/pending`, which calls `pendingApprovals`. It
  returns only drafts this reader may approve, oldest first:
  `{docType, docId, number, amountPaise, approver, refused, createdAt, href}`.
- **Table columns:** document (docType words), amount (money), approver,
  refused (bool, alert), waiting since (`when`), and an open link (`href`).
- **On each approvable record page** (PO, purchase invoice, payment of kind
  `pay`, voucher, material request), while it is a draft, add an inline form:
  - posts to `POST /approvals/decide`;
  - fields: hidden `docType` and `docId`, `decision` (radio: approved or
    refused), `note` (textarea, optional).

  Submitting a draft that needs an approval it lacks is refused with
  `409 needs_approval`, and the message names the approver.
- **An approval binds the draft as it stands.** Editing the draft afterwards
  voids the approval, and it shows up as pending again.

---

## B. Ledger and setup

### B1. `/accounts` Chart of accounts (OFFICE read, ADMIN change)
- **Load:** `GET /accounts`, which calls `listAccounts`. It returns
  `ChartAccount[]` in tree order, with `depth`, `isGroup`, `parentId`,
  `purpose`, `subtype`, `type`, `cashFlow` and `archivedAt`.
- **Table:**
  - code, with `indent: 'depth'`;
  - name, linking to `/reports/general-ledger?accountId={id}` (none for
    groups);
  - type, subtype, purpose (code), cash flow, and archived (status).
  - Set `emphasis: 'isGroup'` and `fixedOrder`.
- **Forms (ADMIN):**
  - **Add account** (action) posts to `POST /accounts`. Fields:
    - `code` and `name`;
    - `type` (asset, liability, equity, income or expense);
    - `parentCode` (select `groups`) and `isGroup` (checkbox);
    - `subtype` (select of the `accountSubtypes` in `api/schemas.ts`) and
      `purpose` (select of `accountPurposes`, optional);
    - `currency` (optional, for a foreign bank account);
    - `cashFlow` (operating, investing or financing) and `description`.
  - **Change account** (action) posts to `POST /accounts/update`. Fields:
    `accountId` (select `accounts`), `name`, `parentCode`, `subtype`,
    `purpose`, `cashFlow` and `description`. All except `accountId` are
    optional.
  - **Close or reopen** is a bulk action on rows, `POST /accounts/archive`
    with `{accountId, archived}`. One per row is fine, or a form with
    `accountId` plus an `archived` checkbox.
- **Note:** `purpose` is how the engine finds an account, for example
  `accounts_receivable`, `gst_output` or `round_off`. Re-purposing an account
  moves future postings.

### B2. `/journal` Posted entries: **exists** (ADMIN)
- Lists `GET /journal` and shows lines when `?entryId=`.
- The manual entry form posts to `POST /journal`. This path is for
  administrators. Day-to-day adjustments go through vouchers (§E4), which
  have numbering, approval and a draft state.
- Keep it as it is. The reverse form posts `POST /journal/reverse`
  `{entryId, reason}`.

### B3. `/periods`: **exists**
- `POST /periods/close` takes `{year, month, reason?}`.
- `POST /periods/reopen` takes `{year, month, reason}`.

### B4. `/budgets`: **exists**
- `GET /budgets?year=&costCenter=` feeds it.
- `POST /budgets` takes `{year, costCenter, accountCode, amount, hardLimit, note}`.

### B5. `/settings` Settings and fiscal years (ADMIN; OFFICE read)
- **Load:** `GET /settings` (`getSettings`) and `GET /fiscal-years`
  (`listFiscalYears`).
- **Inline form** posts to `POST /settings`. Every field is optional, and
  `value` holds the current setting:
  - `legalName`, `address`, `gstin`, `stateCode` (2-digit GST state code),
    `pan` and `tan`;
  - `baseCurrency` (warn: change it only before the first posting);
  - `fiscalYearStartMonth` (1–12, default 4) and `timeZone`;
  - `roundInvoices` (checkbox);
  - `stockValuation` (`moving_average` or `fifo`), `allowNegativeStock`
    (checkbox), `overReceiptPercent` (number) and `blockExpiredBatches`
    (checkbox).
- **Table** of fiscal years: label, starts, ends, status (status badge),
  closed at, and reopened reason.
- **Forms:**
  - **Close year** posts to `POST /fiscal-years/close` with `{label}`
    (select of the open labels). It carries the surplus to retained surplus.
  - **Reopen year** posts to `POST /fiscal-years/reopen` with
    `{label, reason}`. Only the latest closed year can be reopened.

### B6. `/cost-centers` (ADMIN change)
- **Load:** `GET /cost-centers`, a tree with `depth`.
- **Table:** code (`indent: 'depth'`), name, and archived.
- **Forms:**
  - Add posts to `POST /cost-centers` with `{code, name, parentCode?}`
    (select `costCenters`).
  - Close or reopen posts to `POST /cost-centers/archive` with `{id, archived}`.

### B7. `/funds` Funds and grants (ADMIN change)
- **Load:** `GET /funds`, plus `GET /reports/funds` (`fundBalances`) for
  balances.
- **Table:** code, name (link to `/reports/fund?fundId={id}`), kind,
  grantor, sanctioned (money), received, spent, and balance.
- **Add form** posts to `POST /funds`. Fields:
  - `code` and `name`;
  - `kind` (unrestricted, restricted, endowment or grant);
  - `grantor`, `sanctionRef` and `sanctioned` (money);
  - `startsOn`, `endsOn` and `note`.

### B8. `/currencies` (OFFICE; adding a currency is ADMIN)
- **Load:** `GET /currencies`, which returns `{currencies, rates}`.
- **Tables:**
  - currencies: code, name, symbol, minor units, and base (bool);
  - rates, latest first: currency, on, rate, source, and entered at.
- **Forms:**
  - Add currency (ADMIN) posts to `POST /currencies` with
    `{code, name, symbol?, minorUnits}`.
  - Enter rate posts to `POST /currencies/rates` with
    `{currency, on, rate, source?}`, where `rate` is "83.25" (units of base
    per 1 unit of foreign).
  - Revalue posts to `POST /currencies/revalue` with `{on}`. Explain in a
    note: it values open foreign-currency invoices at that day's rate, and
    reverses on the next day.

### B9. `/series` Document numbering (ADMIN)
- **Load:** `GET /series`, which returns `[{docType, prefix, padding, custom, issued}]`.
- **Table:** docType, prefix, padding, custom (bool), and issued (count).
- **Form** posts to `POST /series` with `{docType (select), prefix, padding}`.
  Prefix tokens: `{FYS}` is the fiscal year in four digits (`2627`), and
  `{FY}` its name (`2026-27`).
- `prefix` and padding together must fit in 16 characters.

### B10. `/approval-rules` (ADMIN)
- **Load:** `GET /approval-rules`.
- **Table:** document kind, from amount (`minAmountPaise`, money), and approver.
- **Forms:**
  - Set rule posts to `POST /approval-rules`. Fields:
    - `docType`: `purchase_order`, `payment_pay`, `journal`,
      `material_request` or `purchase_invoice`;
    - `minAmount` (money, in rupees);
    - `approver`: `institution_admin`, `hod`, `accounts_staff`, or
      `approver` (the capability).
  - Remove posts to `POST /approval-rules/remove` with `{id}`.
- **The highest rule at or below the amount wins.**

### B11. `/staff` Jobs in the books (ADMIN)
- **Load:** `GET /staff`, plus `choices().staff` and `warehouses`.
- **Table:** name, email, capability, and warehouse.
- **Forms:**
  - Grant posts to `POST /staff` with `{userId (select staff), capability, warehouseId?}`.
    The capability is `storekeeper`, `purchaser` or `approver`. A storekeeper
    may be limited to one warehouse.
  - Revoke posts to `POST /staff/revoke` with `{id}`.

### B12. `/taxes` Tax templates and TDS (ADMIN change)
- **Load:** `GET /taxes`, which returns `{templates, sections}`.
- **Tables:**
  - templates: name, kind, treatment, rate (bp→%), summary, and archived;
  - TDS sections: code, name, rate (bp→%), rate without PAN, single and
    annual thresholds (money), and payable account.
- **Forms:**
  - **Load India preset**: a single button, `POST /taxes/india-preset`. It
    loads the GST accounts, the 0/5/12/18/28% slabs (intra CGST+SGST, inter
    IGST), and the common TDS sections. Note: "a starting set; check it with
    your auditor".
  - **Add template** posts to `POST /taxes`. Fields:
    - `name`;
    - `kind` (gst or other);
    - `treatment` (taxable, exempt, nil_rated or non_gst);
    - `components`, a `lines` grid with these columns:
      - `component`: cgst, sgst, utgst, igst, cess or other;
      - `applies`: intra, inter or always;
      - `ratePercent`, `outputAccountCode` and `inputAccountCode`.
  - **Retire template** posts to `POST /taxes/archive` with `{id, archived}`.
  - **Add TDS section** posts to `POST /tds-sections`. Fields: `code`,
    `name`, `ratePercent`, `rateNoPanPercent`, `thresholdSingle`,
    `thresholdAnnual` and `payableAccountCode`.

### B13. `/uoms` and `/item-groups` (ADMIN change)
- **`/uoms`:** `GET /uoms` lists them. `POST /uoms` takes
  `{code, name, whole}`. Whole means quantities must be whole numbers.
- **`/item-groups`:** `GET /item-groups` lists them. `POST /item-groups`
  takes these fields:
  - `name` and `parentId`;
  - default accounts: `stockAccountId`, `expenseAccountId` and
    `incomeAccountId`;
  - `taxTemplateId`.

  An item without its own setting inherits it from its group.

---

## C. Parties

### C1. `/parties?side=customer|supplier&q=&archived=`
- **Load:** `GET /parties`. Rows carry `receivablePaise` and `payablePaise`.
- **Filter (GET):** `side`, `q`, and `archived` (checkbox).
- **Table:** code, name (link to `/party?id={id}`), GSTIN, state, customer
  and supplier (bool), owed to us (money), we owe (money), and MSME (bool).
- **Add form** (action) posts to `POST /parties`. Fields:
  - `code` and `name`;
  - `isCustomer` and `isSupplier`;
  - tax: `gstin`, `pan`, `stateCode` (2 digits), and `gstCategory`
    (registered, unregistered, composition, sez or overseas);
  - contact: `address`, `email` and `phone`;
  - terms: `currency`, `paymentTermsDays`, `creditLimit` (money), and
    `tdsSectionId` (select `tds`);
  - `msme` and `msmeNumber`;
  - bank: `bankName`, `bankAccount` and `ifsc`.

  The answer has `next` set to `/party?id=`.

### C2. `/party?id=` Party
- **Load:**
  - the party, from `listParties` filtered, or add a `partyDetail` if
    preferred;
  - `GET /parties/statement?partyId=&side=&from=&to=`;
  - `GET /payments/open-invoices?partyId=&side=`.
- **Record sidebar:** code, GSTIN, PAN, state, terms, credit limit, and MSME.
- **Sections:**
  1. Figures: owed to us and we owe.
  2. A GET filter (`side`, `from`, `to`) and the **statement** table:
     - columns: date, voucher type, voucher (link by type, see below),
       amount (money), and running balance;
     - set `fixedOrder`, with the opening and closing as the footer.
  3. **Open invoices:** number (link), date, due, total (fc), and
     outstanding (fc).
  4. Shortcuts:
     - new invoice: `/invoice/new?kind=sales&partyId=` (or `purchase`);
     - record payment: `/payment/new?kind=receive&partyId=` (or `pay`).
  5. **Set off advances** form: `POST /parties/apply-advances` with
     `{partyId, side, on?}`. Explain: "sets this party's advances and credit
     notes against their oldest open invoices".
  6. **Edit** form posts to `POST /parties/update` with `{partyId, …any party field}`.
  7. **Archive or restore** posts to `POST /parties/archive` with
     `{partyId, archived}`.
- **Voucher link by type:**

  | `voucherType` | Link |
  |---|---|
  | `sales_invoice` or `purchase_invoice` | `/invoice?id=` |
  | `payment` | `/payment?id=` |
  | `journal` | `/voucher?id=` |
  | `advance_applied` | the crediting voucher's page |

---

## D. Documents: invoices, orders, receipts

All three share one pattern: list → new → record.

### D1. `/invoices?kind=sales|purchase&status=&partyId=&q=&from=&to=`
- **Load:** `GET /invoices`. Rows are the invoice plus `partyName`,
  `outstandingFc` and `status`.
- **Links (tabs):** All, Draft, Open, Overdue, Paid, Cancelled, and Returns
  (`status=return`).
- **Filter (GET):** party (select), `from`, `to` and `q`.
- **Table:**
  - number (link to `/invoice?id={id}`, `code`; "Draft" when it has none);
  - date, party, and bill no (purchase only);
  - due (date, alert when status is `overdue`);
  - total (fc), outstanding (fc), and status (status).
- **Action:** "New sales invoice" or "New bill" links to `/invoice/new?kind=`.

### D2. `/invoice/new?kind=&partyId=` and the draft's edit form
- **Load:** `choices()`, plus the prefill from the query.
- **Form** posts to `POST /invoices`, with `submit` as a checkbox labelled
  "Submit now". The answer's `next` is `/invoice?id=`.
- **Header fields:**
  - `kind` (hidden), `partyId` (select `customers` or `suppliers`);
  - `postingDate` and `dueDate` (default: posting date plus the party's
    terms);
  - purchase only: `billNo` and `billDate`. The engine refuses a duplicate
    bill no for the same supplier and fiscal year;
  - `currency` (select `currencies`, default base) and `exchangeRate` (shown
    when the currency is foreign; default is that day's rate from
    `/currencies`);
  - `placeOfSupply` (state code, default party's state);
  - `reverseCharge` (purchase);
  - `updateStock` (the invoice moves stock itself, no receipt), with
    `warehouseId`;
  - purchase: `tdsSectionId` (default party's);
  - `costCenter`, `fundId`, `memo` and `terms`.
- **`lines` grid columns:**
  - `itemId` (select `items`) and `description`;
  - `qty` (number, step any), `rate` (money) and `discount` (%);
  - `taxTemplateId` (select `taxes`; default item's or group's);
  - `accountId` (select income or expense accounts; default item's);
  - `costCenter` and `warehouseId`;
  - `batchNo` and `expiresOn` (batch items on a purchase that updates stock);
  - `serials` (text: separated by spaces, commas or semicolons; one per unit).

  Hidden per line: `orderLineId` and `receiptLineId`. Carry them through an
  edit of a draft that was raised from an order or receipt.
- **How the engine computes:**
  - **Intra or inter state** comes from `placeOfSupply` against the
    institution's `stateCode`.
  - **Rounding** to the rupee follows the `roundInvoices` setting.
  - **TDS** is deducted on purchase above the section thresholds.
  - **Asset items** on a purchase create draft assets, one per unit when the
    quantity is whole and ≤ 100.
  - **Show computed totals only after save** (on the record page). Do not
    re-implement the tax maths in the page.

### D3. `/invoice?id=` Invoice record
- **Load:** `GET /invoices/detail?invoiceId=`. It returns:
  - the document: `{invoice, party, lines, taxes, outstanding, status}`;
  - what touched it: `settlements`, `returns`, `posting`, `assets` and
    `approvals`.
- **Record:** use `docRecord`:
  - `entity: 'finance_invoice'`, `idField: 'invoiceId'`, `base: '/invoices'`;
  - title "Sales invoice SI/2627/0001" (or "Bill …", "Credit note …" when
    `isReturn`);
  - fields: party, date, due, bill no, currency and rate, place of supply,
    reverse charge, cost centre, fund;
  - status: the invoice `status` with its tone.
- **Sections by state:**
  - **Draft:**
    - the D2 form, prefilled (`value` set for the header; the `lines`
      field's `value` set to a data key of the lines as strings, using
      `formatDecimal`/`formatQty`);
    - the approval form (purchase invoice, when a rule applies);
    - a Delete button posting to `POST /invoices/delete` with `{invoiceId}`.
  - **Submitted:**
    - a lines table: item, description, HSN/SAC, qty, rate (fc),
      discount %, amount (fc);
    - a taxes table: component, rate, taxable, tax (fc), ineligible (money);
    - totals as `footer` or figures: net, tax, rounding, total, TDS,
      outstanding;
    - settlements: date, voucher type, voucher (link), amount;
    - returns, by link;
    - the GL posting: account, debit, credit, cost centre, memo;
    - assets created, by link;
    - shortcuts:
      - **Print** links to `/api/v1/modules/finance/invoices/pdf?invoiceId=`
        (raw, opens a PDF);
      - **Record payment** links to
        `/payment/new?kind=receive|pay&partyId=&invoiceId=`;
      - **Make recurring** is a form posting to `POST /recurring` with
        `{invoiceId, every (month, quarter or year), nextOn, endsOn?, autoSubmit}`;
    - the **Credit or debit note** form posts to `POST /invoices/return`:
      - fields: `{invoiceId, postingDate?, memo?, submit}`, and a `lines`
        grid with `lineId` (hidden) and `qty`;
      - prefill one row per original line with its quantity;
      - the answer goes to the new draft.
  - **Cancelled:** read-only tables. The amend button comes from `docRecord`.
- **Refusals to expect:**

  | Error | Meaning |
  |---|---|
  | `409 invoice_settled` | it cannot be cancelled while a payment, return or advance is set against it; cancel or take those back first |
  | `409 invoice_returned` | a return stands against it; cancel the return first |
  | `409 credit_limit` | the customer is over their limit |
  | `409 needs_approval` | the draft lacks an approval |

  `credit_limit` can be overridden: re-submit with
  `{invoiceId, overrideCreditLimit: true}`. Offer that as a second submit
  button (ADMIN).

### D4. `/orders?kind=quotation|sales_order|purchase_order&status=&partyId=`
- **Load:** `GET /orders`. The `kind` defaults to `purchase_order`.
- **Tabs:** the status values that apply to the kind (§0.7).
- **Table:** number (link to `/order?id=`), date, party, deliver by or valid
  till, total (fc), and status.
- **Action:** a link to `/order/new?kind=`.

### D5. `/order/new?kind=` and the draft edit
- **Form** posts to `POST /orders`. The answer's `next` is `/order?id=`.
- **Header fields:**
  - `kind` (hidden) and `partyId`;
  - `postingDate`, plus `deliverBy` (orders) or `validTill` (quotation);
  - `currency`, `exchangeRate` and `placeOfSupply`;
  - `warehouseId`, `costCenter`, `fundId`, `terms` and `memo`.
- **`lines` columns:**
  - `itemId`, `description`, `qty`, `rate` and `discount`;
  - `taxTemplateId`, `warehouseId`, `costCenter` and `deliverBy`;
  - hidden: `requestLineId` and `quotationLineId`.

### D6. `/order?id=` Order record
- **Load:** `GET /orders/detail?orderId=`. It returns:
  - the order: `{order, party, lines, closure, status}`. Each line carries
    `movedMilli`, `billedMilli` and `orderedMilli`;
  - what followed it: `{receipts, invoices, approvals}`.
- **Record:** `docRecord`, with `entity: 'finance_order'`,
  `idField: 'orderId'` and `base: '/orders'`.
- **Submitted sections:**
  - **Progress table:** item, ordered qty, received or delivered, billed,
    and left.
  - Receipts and invoices raised from it, by link.
  - **Actions**, by kind:
    - **Quotation:** "Make sales order" posts to
      `POST /orders/from-quotation` with `{quotationId}`.
    - **Sales order:**
      - "Make delivery note" posts to `POST /receipts/from-order` with
        `{orderId, postingDate?, submit}`;
      - "Make invoice" posts to `POST /invoices/from-order` with
        `{orderId, postingDate?, updateStock, submit}`.
    - **Purchase order:**
      - "Make goods receipt" posts to `POST /receipts/from-order`;
      - "Make bill" posts to `POST /invoices/from-order`.
    - **Close short** (submitted orders) posts to `POST /orders/close` with
      `{orderId, reason}`.
    - **Print** links to `/api/v1/modules/finance/orders/pdf?orderId=`.
- **Draft sections:** the D5 form prefilled, the approval form (PO), and
  Delete (`POST /orders/delete`).
- **Cancel** is refused once anything has moved against the order. Offer
  Close instead.

### D7. `/receipts?kind=purchase_receipt|delivery_note&partyId=`
- **Load:** `GET /receipts`.
- **Table:** number (link to `/receipt?id=`), date, party, order (link),
  challan no, total (money), return (bool), and docstatus.

### D8. `/receipt/new?kind=&orderId=` and the draft edit
- Prefer creating from an order (D6). A direct receipt is allowed.
- **Form** posts to `POST /receipts`. Header fields:
  - `kind`, `partyId` and `orderId`;
  - `postingDate`, `challanNo` and `transporter`;
  - `costCenter`, `memo`, `currency` and `exchangeRate`.
- **`lines` columns:**
  - `itemId` and hidden `orderLineId`;
  - `warehouseId`, `qty`, `rejected` and `rate`;
  - `batchNo`, `expiresOn` and `serials`.
- Over-receipt beyond `overReceiptPercent` of the order is refused.

### D9. `/receipt?id=`
- **Load:** `GET /receipts/detail?receiptId=`, which returns
  `{receipt, party, lines(+billedMilli)}`.
- **Record:** `docRecord`, with `entity: 'finance_receipt'`,
  `idField: 'receiptId'` and `base: '/receipts'`. There is no amend
  (`amend: false`).
- **Submitted sections:**
  - lines: item, store, qty, rejected, rate, batch, serials, and billed.
  - **Make bill or invoice** posts to `POST /invoices/from-receipt` with
    `{receiptId, postingDate?, billNo?, submit}`. The bill clears
    stock-received-not-billed at the receipt value, and a price difference
    goes to stock adjustment.
  - **Return goods** posts to `POST /receipts/return` with
    `{receiptId, postingDate?, lines:[{lineId, qty}], submit}`.
- **Draft sections:** the edit form and Delete (`POST /receipts/delete`).

### D10. `/recurring`
- **Load:** `GET /recurring`.
- **Table:** template invoice number (link), party, kind, total (fc), every,
  next on, ends on, auto-submit, and stopped.
- **Forms:**
  - **Run due now** posts to `POST /recurring/run` with `{on?}`. Note: a
    daily job should call this. It will be wired to the Postgres job queue
    in Phase 5.
  - **Stop** posts to `POST /recurring/stop` with `{recurringId}`.

---

## E. Payments and vouchers

### E1. `/payments?kind=receive|pay|transfer&partyId=&status=&from=&to=`
- **Load:** `GET /payments`.
- **Tabs:** Received, Paid and Transfers.
- **Table:** number (link to `/payment?id=`), date, kind, party, bank or
  cash account, amount (fc), TDS (money), mode, reference, and docstatus.

### E2. `/payment/new?kind=&partyId=&invoiceId=` and the draft edit
- **Load:** `choices()`. When `partyId` is given, also load
  `GET /payments/open-invoices?partyId=&side=&currency=`.
- **Form** posts to `POST /payments`. Header fields:
  - `kind` (hidden) and `partyId` (receive or pay);
  - `side` (optional): a payment to a customer means `receivable`;
  - `postingDate`;
  - `accountId` (select `cashBank`, the account money goes into or out of);
  - transfer only: `toAccountId`;
  - `currency`, `exchangeRate` and `amount` (money);
  - `tds` (money) and `tdsSectionId`: TDS deducted by the customer on a
    receipt, or by us on a payment;
  - `bankCharges`;
  - `mode`: cash, cheque, dd, neft, rtgs, imps, upi, card, wire or other;
  - `instrumentNo`, `instrumentDate`, `reference` and `memo`;
  - `costCenter` and `fundId`;
  - `autoAllocate` (checkbox: oldest invoices first);
  - `submit`.
- **`allocations` grid:** `invoiceId` (select of open invoices) and `amount`.
  Prefill one row per open invoice, with `invoiceId` preset when it was
  given in the query.
- **How the engine treats amounts:**
  - Whatever is not allocated stays an **advance**. Set it off later from
    the party page.
  - Foreign currency: a realised exchange gain or loss is posted against the
    invoice's booked rate.

### E3. `/payment?id=`
- **Load:** `GET /payments/detail?paymentId=`. It returns:
  - the payment: `{payment, party, allocations, open}`;
  - what it moved: `{posting, applied, approvals}`.
- **Record:** `docRecord`, with `entity: 'finance_payment'`,
  `idField: 'paymentId'` and `base: '/payments'`.
- **Sections:**
  - allocations: invoice (link), date, total, and allocated;
  - applied advances;
  - the GL posting;
  - Print links to `/api/v1/modules/finance/payments/pdf?paymentId=` (a
    receipt or voucher);
  - drafts: the edit form, the approval form (`pay`), and Delete.
- **Cancel** first un-applies any advances the payment carried.

### E4. `/vouchers?kind=&status=` · `/voucher/new?kind=` · `/voucher?id=`
- **List:** `GET /vouchers`.
  - Tabs: journal, contra, opening and adjustment.
  - Columns: number (link), date, kind, memo, reference, total (money), and
    docstatus.
- **Form** posts to `POST /vouchers`. Header fields:
  - `kind` (journal, contra, opening or adjustment);
  - `postingDate`, `memo` (required) and `reference`.
- **`lines` columns:**
  - `accountId` (select `accounts`);
  - `partyId` (select `parties`; **required** on receivable and payable
    accounts);
  - `debit` and `credit` (money);
  - `costCenter` and `fundId`;
  - foreign currency: `currency`, `amountFc` and `exchangeRate`;
  - `memo`.

  Offer about 8 rows and a "more rows" link (`lineCount`).
- **Opening vouchers:** the difference goes to the `opening_balance` account
  automatically. Explain that this is how opening balances are entered,
  including parties' open amounts.
- **Record:** `GET /vouchers/detail?journalId=`, which returns
  `{journal, lines(+code, accountName, partyName), posting, approvals}`.
  - Use `docRecord` with `entity: 'finance_journal'`,
    `idField: 'journalId'` and `base: '/vouchers'`.
  - Drafts get the edit form, the approval form, and Delete.

---

## F. Stock

Stock entries, issues and batches need the `storekeeper` capability or an
OFFICE role. The engine checks this.

### F1. `/items?q=&groupId=&archived=`
- **Load:** `GET /items`. Rows carry `qtyMilli`, `valuePaise` and `nature`.
- **Table:** code, name (link to `/item?id=`), group, UoM, nature, HSN/SAC,
  held (`qty`), value (money), batch and serial (bool), and reorder level.
- **Add form** posts to `POST /items`. Fields:
  - `code`, `name`, `groupId` and `uom` (select of `/uoms`);
  - `nature`: stock, service or asset. An asset item also needs
    `assetCategoryId`;
  - `hsnSac`, `taxTemplateId`, `expenseAccountId` and `incomeAccountId`;
  - `hasBatch` and `hasSerial`. These are fixed after creation;
  - `valuation`: blank (the institution default), `moving_average` or `fifo`;
  - `reorderLevel`, `reorderQty`, `standardRate` and `description`.

  The answer's `next` is `/item?id=`.

### F2. `/item?id=`
- **Load:**
  - the item row;
  - `GET /stock/balance?itemId=`;
  - `GET /stock/ledger?itemId=&from=&to=`;
  - `GET /batches?itemId=`;
  - `GET /stock/serials?itemId=`.
- **Sections:**
  - balance by store;
  - the ledger: date, voucher (type, link), store, batch, qty change, qty
    after, value change, and value after. Set `fixedOrder`;
  - batches: batch no, made, expires, and qty;
  - serials: serial, status, store, and asset;
  - the edit form posts to `POST /items/update`. All item fields except
    code, nature, batch, serial and UoM;
  - archive posts to `POST /items/archive`.

### F3. `/warehouses` (ADMIN change)
- **Load:** `GET /warehouses`.
- **Table:** code, name, group, items held, value, cost centre, and archived.
- **Forms:**
  - Add posts to `POST /warehouses` with
    `{code, name, parentId?, isGroup, stockAccountId?, costCenter?}`.
  - Archive posts to `POST /warehouses/archive` with `{warehouseId, archived}`.

### F4. `/batches?itemId=`
- **Load:** `GET /batches`. A batch can be added ahead of a receipt with
  `POST /batches` `{itemId, batchNo, madeOn?, expiresOn?}`.
- Receipts with a new `batchNo` create the batch themselves.

### F5. `/stock-entries?kind=&status=` · `/stock-entry/new?kind=` · `/stock-entry?id=`
- **List:** `GET /stock-entries`.
  - Tabs: receipt, issue, transfer and reconciliation (a count).
  - Columns: number (link), date, kind, memo, cost centre, and docstatus.
- **Form** posts to `POST /stock-entries`. Header fields:
  - `kind` and `postingDate`;
  - `memo`, `costCenter` and `fundId`;
  - `accountId`: the other side; default is the item's expense account for
    an issue, and stock adjustment for a receipt or count;
  - `materialRequestId` (hidden, when raised from a request);
  - `submit`.
- **`lines` columns:**
  - `itemId`, `fromWarehouseId` and `toWarehouseId`;
  - `qty`;
  - `rate`: receipt only. For a count (reconciliation), `qty` is the counted
    quantity and `rate` the valuation;
  - `batchNo`, `expiresOn` and `serials`.
- **Which stores a line needs, by kind:**

  | Kind | From store | To store |
  |---|---|---|
  | issue | yes | no |
  | receipt | no | yes |
  | transfer | yes | yes |
  | count | no | yes (the store counted) |
- **Record:** `GET /stock-entries/detail?stockEntryId=`.
  - `docRecord` with `entity: 'finance_stock_entry'`,
    `idField: 'stockEntryId'` and `base: '/stock-entries'`. There is no amend.
  - The lines table: item, from, to, qty, rate, amount, batch, and serials.
  - Drafts get the edit form and Delete (`POST /stock-entries/delete`).
- **Refusals to expect:**
  - `409 finance_stock_negative`: not that much in that store, unless the
    setting allows negative stock;
  - `400 serials_required`: one serial per unit;
  - `409 batch_expired`: when `blockExpiredBatches` is on.

### F6. Stock reports. Each one is a GET filter plus a table.

| Page | Route | Filter fields | Columns |
|---|---|---|---|
| `/stock/balance` | `GET /stock/balance` | `on`, `warehouseId`, `itemId` | item code, name, store, qty, rate (money), value (money); footer: total value |
| `/stock/ledger` | `GET /stock/ledger` | `itemId`, `warehouseId`, `from`, `to` | as F2 ledger, plus item |
| `/stock/reorder` | `GET /stock/reorder` | none | item, level, held, on order, suggested; action: "Raise PO", a link to `/order/new?kind=purchase_order` |
| `/stock/expiry` | `GET /stock/expiry` | `days` (default 30) | batch, item, store, qty, expires; alert when `expired` |
| `/stock/serials` | `GET /stock/serials` | `itemId`, `q` | serial, item, status, store, asset (link) |
| `/stock/against-books` | `GET /stock/against-books` | none | account, stores value, books value, difference (alert ≠ 0) |

---

## G. Buying

### G1. `/material-requests?mine=&status=` (STAFF)
- **Load:** `GET /material-requests`. Only storekeepers and purchasers (and
  OFFICE, who hold every job) see everyone's; others see only their own.
  `mine=true` forces that.
- **Table:** number (link), date, purpose (issue or purchase), requested by,
  required by, cost centre, status, and docstatus.

### G2. `/material-request/new` and the draft edit (STAFF)
- **Form** posts to `POST /material-requests`. Header fields:
  - `purpose`: issue from stock, or purchase;
  - `costCenter`, `warehouseId` and `requiredBy`;
  - `reason` and `submit`.
- **`lines` columns:** `itemId`, `qty` and `note`.

### G3. `/material-request?id=`
- **Load:** `GET /material-requests/detail?requestId=`, which returns
  `{request, lines(+issuedMilli, orderedMilli), approvals, issues}`.
- **Record:** `docRecord`, with `entity: 'finance_material_request'`,
  `idField: 'requestId'` and `base: '/material-requests'`.
  - Submit means "Send to the stores".
  - Cancel posts to `POST /material-requests/cancel` with
    `{requestId, reason}`.
  - Roles: `STAFF`.
- **Sections:**
  - lines: item, qty, issued, ordered, and note;
  - issues made, by link;
  - the approval form, on a draft;
  - storekeeper: **Issue** posts to `POST /material-requests/issue` with
    `{requestId, warehouseId?}`. It drafts an issue stock entry and goes
    there;
  - purchaser: **Order** posts to `POST /material-requests/order` with
    `{requestId, partyId}`. It drafts a PO; enter the prices there;
  - **Ask for quotations** links to `/rfq/new?requestId=`.

### G4. `/rfqs`, `/rfq/new?requestId=` and `/rfq?id=`
- **List:** `GET /rfqs`.
- **New:** `POST /rfqs`. Fields:
  - `postingDate`, `respondBy` and `terms`;
  - `requestId` (hidden);
  - `supplierIds` (`checkboxes`, options `suppliers`);
  - `lines`: `itemId`, `qty` and hidden `requestLineId`;
  - `submit`.
- **Record:** `GET /rfqs/compare?rfqId=`, which returns
  `{rfq, suppliers, items:[{itemName, qtyMilli, offers:[{supplier, rate, currency, leadDays, validTill, expired, lowest}]}], answered}`.
  - **Comparison table:** one row per item × offer. Columns: item, supplier,
    rate, lead days, valid till, and lowest (bool, emphasis).
  - Link "Record a quotation" to `/supplier-quotation/new?rfqId=`.
  - **Order from the best offer** posts to
    `POST /orders/from-supplier-quotation` with
    `{supplierQuotationId, lineIds?}`.

### G5. `/supplier-quotations` and `/supplier-quotation/new?rfqId=`
- **List:** `GET /supplier-quotations`. Columns: number, supplier, quoted on,
  valid till, currency, and docstatus.
- **Form** posts to `POST /supplier-quotations`. Header fields:
  - `rfqId` (hidden) and `partyId`;
  - `quotedOn`, `validTill`, `currency` and `terms`;
  - `submit`.
- **`lines` columns:**
  - `itemId`, `qty` and `rate`;
  - `taxTemplateId` and `leadDays`;
  - hidden `rfqLineId`.

### G6. `/commitments`
- **Load:** `GET /commitments`, which returns `[{costCenter, openPaise, orders}]`
  (POs submitted but not yet billed).
- Show it beside `/budgets` by linking the two.

---

## H. Fixed assets

### H1. `/assets?on=&categoryId=&status=`
- **Load:** `GET /assets`. Rows carry `category`, `custodian`, `location`,
  `accumulatedPaise`, `netPaise`, `status` and `disposedOn`.
- **Status** is one of `draft`, `in_use` or `disposed`.
- **Table:**
  - number (link to `/asset?id=`), name and category;
  - in use on, gross (money), accumulated, and net book value;
  - location, custodian, tag, and status.
- **Footer:** totals.
- **Actions:**
  - **New asset** links to `/asset/new`.
  - **Run depreciation** posts to `POST /depreciation/run` with `{upTo?}`.
    It posts every period that has ended, one entry per period end.

### H2. `/asset/new` and the draft edit
- **Form** posts to `POST /assets`. Fields:
  - `name`, `categoryId`, `itemId` and `purchasedOn`;
  - `inUseOn` (default: the purchase date) and `gross` (money);
  - `existing`: an asset from earlier books. When ticked, also give
    `openingAccumulated` and `depreciateFrom`;
  - `creditAccountId`: for a manual asset; default is capital WIP;
  - `locationId` (warehouse), `custodianId` (select `staff`), `costCenter`
    and `fundId`;
  - `warrantyTill`, `insuredTill`, `tagCode` and `note`;
  - `submit`, which capitalises the asset.
- Assets bought on a purchase invoice arrive as drafts, already filled. Open
  one and submit it.

### H3. `/asset?id=`
- **Load:** `GET /assets/detail?assetId=`, which returns
  `{asset, category, schedule, events, accumulatedPaise, netPaise}`.
- **Record:** `docRecord`, with `entity: 'finance_asset'`,
  `idField: 'assetId'` and `base: '/assets'`. Submit is labelled
  "Capitalise", and there is no amend.
  - Cancel is allowed only before any depreciation or movement.
- **Sections:**
  - figures: gross, accumulated, and NBV;
  - the **schedule**: period end, amount, accumulated after, and posted
    (bool, from `entryId`). Set `fixedOrder`;
  - events: on, kind, details, cost or amount, and recorded by;
  - the **Record event** form posts to `POST /assets/events`:
    - always: `assetId` (hidden), `kind`, `on` and `note`;
    - by kind:

      | Kind | Fields |
      |---|---|
      | transfer | `toLocationId`, `toCustodianId`, `toCostCenter` |
      | maintenance | `cost`, `vendorId`, `nextDueOn` |
      | verification | `finding` (found, elsewhere or missing) |
      | impairment | `amount` (write-down; the schedule is recomputed) |
      | sold | `amount` (proceeds), `proceedsAccountId` (or receivable). Posts gain or loss to `asset_disposal` |
      | scrapped | none extra |

    One form with all fields optional is fine. Better: one form per kind,
    shown as an action menu.

### H4. `/asset-categories` (ADMIN change)
- **Load:** `GET /asset-categories`.
- **Table:** name, method, life (`lifeMonths`/12, in years), rate
  (`rateBp`→%), residual %, and frequency.
- **Add form** posts to `POST /asset-categories`. Fields:
  - `name` and `method`:
    - **SLM**: equal monthly charges, part months prorated, the exact total
      reached;
    - **WDV**: rate on opening NBV per fiscal year, by days;
    - **none**;
  - `lifeYears` (SLM), `ratePercent` (WDV), `residualPercent`, `frequency`
    (month or year);
  - the three accounts. They are optional; the defaults are fixed assets,
    accumulated depreciation, and depreciation expense.

### H5. `/depreciation?from=&to=`
- **Load:** `GET /depreciation`, which returns
  `[{category, assets, amountPaise, postedPaise}]`.
- Add a GET filter and a "Run depreciation" action (as on H1).

### H6. `/assets/maintenance?days=`
- **Load:** `GET /assets/maintenance-due`.
- **Columns:** asset (link), last on, next due, and overdue (alert).

---

## I. Bank

### I1. `/bank` Bank accounts
- **Load:** `GET /bank-accounts`. Rows carry `booksPaise`, `unmatched` and
  `lastStatement`.
- **Table:**
  - bank name (link to `/bank-account?id=`), branch, account number, IFSC,
    currency;
  - GL account (code and name), book balance (money), unmatched lines
    (count, alert > 0), and last statement date.
- **Add (ADMIN)** posts to `POST /bank-accounts`. Fields:
  - `bankName`, `branch`, `ifsc`, `accountNumber` and `currency`;
  - `accountId`: an existing GL account. Leave it blank to have one created
    under Bank with subtype `bank`.

  The answer's `next` is `/bank-account?id=`.

### I2. `/bank-account?id=&status=unmatched|matched|ignored&statementId=`
- **Load:**
  - the account (from the list);
  - `GET /bank-statements?bankAccountId=`;
  - `GET /bank-lines?bankAccountId=&status=&statementId=`.
- **Sections:**
  1. **Import statement:** a `file` field `file` (`accept`: `.csv`,
     `.xlsx`, `.sta`, `.mt940`, `.xml`) and hidden `bankAccountId`. Posts to
     `POST /bank-statements/import`.
     - The format is recognised from the content: CSV, XLSX, MT940, or
       camt.053.
     - CSV and XLSX columns are guessed on first import, and the guess is
       saved as this bank's mapping.
     - The same file twice is refused (sha256).
     - Lines are auto-matched on import.
  2. **Column mapping** (action) posts to `POST /bank-accounts/mapping`.
     - Fields: `bankAccountId` (hidden), then `date`, `valueDate`,
       `description`, `reference`, `withdrawal`, `deposit`, `amount`, `drCr`
       and `balance`. Each is the column header text in the bank's download.
     - Also `dateOrder` (dmy, mdy or ymd).
     - Prefill it from `csvMapping`.
  3. **Statements** table: file, format, from, to, opening, closing, lines,
     and imported at.
     - Delete posts to `POST /bank-statements/delete` with `{statementId}`.
       It is refused if any line is matched.
  4. **Tabs:** Unmatched, Matched, and Set aside.
  5. **Lines** table: date, description, reference, withdrawal (money),
     deposit (money), balance, and status.
     - The row link goes to `/bank-line?id={id}`.
  6. Actions:
     - **Auto-match** posts to `POST /bank/auto-match` with `{bankAccountId}`.
     - **Apply rules** posts to `POST /bank-rules/apply` with
       `{bankAccountId}`.
     - **Reconciliation** links to
       `/bank/reconciliation?bankAccountId=&on=`.

### I3. `/bank-line?id=` Match one line
- **Load:** the line, plus `GET /bank-lines/candidates?lineId=`. The
  candidates are GL lines on this bank's account with the same amount and
  direction, within ±7 days, and not yet matched. Each comes with `days`
  apart.
- **Sections:**
  - **Candidates** table: date, memo, line memo, source ref, debit, credit,
    and days apart.
    - Each row has a "Match" action: `POST /bank-lines/match` with
      `{lineId, glLineId}`. Use a one-row form per candidate, or a bulk
      action with a single tick.
  - **Post it** (the books lack it: charges, interest) posts to
    `POST /bank-lines/post` with `{lineId, accountId, costCenter?, memo?}`.
    It posts and matches in one step.
  - **Set aside** posts to `POST /bank-lines/ignore` with
    `{lineId, note (required)}`.
  - **Unmatch** (when matched) posts to `POST /bank-lines/unmatch` with
    `{lineId}`.
- **Known limit:** one statement line matches exactly one GL line. A
  deposit slip of several receipts must be matched by posting a contra or
  a split. Say so in a note.

### I4. `/bank-rules`
- **Load:** `GET /bank-rules`.
- **Table:** contains, direction, account, cost centre, priority, and bank
  (or "all").
- **Forms:**
  - Add posts to `POST /bank-rules` with
    `{bankAccountId?, contains, direction (in, out or any), accountId, costCenter?, priority}`.
  - Delete posts to `POST /bank-rules/delete` with `{ruleId}`.

### I5. `/bank/reconciliation?bankAccountId=&on=`
- **Load:** `GET /bank/reconciliation`. It returns:
  - balances: `booksPaise`, `expectedBankPaise`, `statementPaise` and
    `differencePaise`;
  - the reconciling items: `notPresented` (cheques issued, not cleared),
    `notCredited` (deposits not yet credited), and `bankOnly` (statement
    lines not in the books).
- **Layout:**
  - the classic BRS:
    - figures first: balance as per books, then less not presented, add not
      credited;
    - then the expected bank balance, the balance as per statement, and the
      difference. Tone `due` when ≠ 0;
  - then the three tables.

---

## J. Reports

Every report page has a GET filter form and reads its period from the query.
When no period is given, it defaults to the current month (`from` to
`today`), or to `on=today`.

Downloads: `GET /api/v1/modules/finance/reports/export.csv?report=…&from=&to=…`
supports these reports:

- `gstr1`, with `table` set to `b2b`, `b2cl`, `b2cs`, `cdnr`, `cdnur`,
  `exports` or `sez`;
- `hsn`, with `kind`;
- `register`, with `kind`;
- `tds`;
- `aging`, with `side` and `on`;
- `trial-balance`;
- `general-ledger`, with `accountId`.

Put a "Download CSV" link on each of those pages.

### J1. `/reports` index
- Shortcuts to every report below, grouped: Statements, Ledgers, Parties,
  Funds and cost centres, GST and TDS, and Stock and assets.

### J2. `/reports/trial-balance?from=&to=&fundId=&costCenter=`
- **Load:** `GET /reports/trial-balance`, which returns `{rows: StatementRow[], totals}`.
  A `StatementRow` is
  `{id, code, name, type, isGroup, depth, parentId, openingPaise, debitPaise, creditPaise, closingPaise}`.
- **Table:** code (`indent: 'depth'`), name (link to the GL for leaves),
  opening, debit, credit, and closing.
  - Set `emphasis: 'isGroup'`, `fixedOrder`, and `footer` showing the totals.

### J3. `/reports/income-expenditure?from=&to=&fundId=&costCenter=&compare=`
- **Load:** `GET /reports/income-expenditure`. It returns `{income[], expense[]}`
  rows (with `amountPaise`, `previousPaise`), plus `incomePaise`,
  `expensePaise` and `surplusPaise`.
- **Sections:** two tables, Income and Expenditure. Columns: name
  (indented), amount, and previous (when `compare`). Then figures: total
  income, total expenditure, and surplus or deficit.

### J4. `/reports/balance-sheet?on=&fundId=`
- **Load:** `GET /reports/balance-sheet`. It returns:
  - the row groups: `assets`, `liabilities` and `funds` (`StatementRow[]`,
    use `closingPaise`);
  - `unclosedSurplusPaise`;
  - the totals and `differencePaise`. It is 0 when the books are right;
    flag anything else.
- **Layout:** three tables, then figures.

### J5. `/reports/cash?from=&to=&fundId=`
- **Load:** `GET /reports/cash`. It returns:
  - balances: `openingPaise` and `closingPaise`;
  - the two sides: `receipts[]` and `payments[]`, each a head with
    received and paid;
  - the activity groups `operating`, `investing` and `financing`, each with
    `heads[]` and `netPaise`.
- **Two views** via tabs (`view=rp|cf`):
  - **Receipts and payments**, the usual statement for a society or trust;
  - **Cash flow by activity**.

### J6. `/reports/general-ledger?accountId=&from=&to=&partyId=&costCenter=`
- **Load:** `GET /reports/general-ledger`. It returns
  `{account, openingPaise, lines[], closingPaise}`.
- **Line columns:** date, memo, line memo, party, cost centre, source, debit,
  credit, and running balance.
  - Set `fixedOrder`. Put the opening and closing in figures.
- A group account lists the lines of all its leaves, with the `account`
  column.

### J7. `/reports/day-book?from=&to=&sourceModule=`
- **Load:** `GET /reports/day-book`, which returns
  `{entries:[{postingDate, memo, sourceModule, sourceRef, reversal, lines[]}]}`.
- Flatten it for a table: one row per line, with the entry's date and memo
  on its first row, and `emphasis` on the entry rows.

### J8. `/reports/aging?side=receivable|payable&on=&partyId=`
- **Load:** `GET /reports/aging`. It returns `{bucketLabels, rows, totals}`.
  Each row has `{partyId, name, buckets[6], advancePaise, totalPaise, invoices[]}`.
- **Table:** party (link to `/party?id=`), one money column per bucket
  label, advance, and total. Map `buckets[i]` to a flat key per column in
  `load`. Add a footer of totals.
- **Drill-down:** with `?partyId=`, show that party's `invoices[]`: number,
  date, due, days, and open.

### J9. `/reports/funds?on=` and `/reports/fund?fundId=&from=&to=`
- **`/reports/funds`:** `GET /reports/funds` (`fundBalances`). Columns:
  code, name (link), kind, sanctioned, received, spent, and balance.
- **`/reports/fund`:** `GET /reports/fund-statement`. It returns
  `{fund, openingPaise, received[], receivedPaise, spent[], spentPaise, capitalPaise, closingPaise, sanctionedPaise, utilisedPercent}`.
  - Layout: figures, then a Received table, then a Spent-by-head table.
  - This is the utilisation certificate's substance.

### J10. `/reports/cost-centers?from=&to=`
- **Load:** `GET /reports/cost-centers`. Columns: cost centre, name, income,
  expenditure, and net.

### J11. GST and TDS
- **`/reports/gst`:** an index of the GST reports, with a period filter.
- **`/reports/gstr1?from=&to=`:** `GET /reports/gstr1`. Show one table per
  table key, with tabs via `?table=`:
  - `b2b`, `sez`, `b2cl`, `exports`, `cdnr` and `cdnur`. Columns: number,
    date, party, GSTIN, place of supply, rate %, taxable, IGST, CGST, SGST,
    cess, invoice value; plus original number and date for notes.
  - `b2cs`: place of supply, rate, and taxable/tax buckets.
  - `nil`: nil-rated, exempt, and non-GST.
  - `hsn`: HSN/SAC, UoM, qty, taxable, and taxes.
  - `documents`: nature, first, last, total, and cancelled.

  B2CL means inter-state B2C invoices above ₹1,00,000 (`B2CL_THRESHOLD_PAISE`).
- **`/reports/gstr3b?from=&to=`:** `GET /reports/gstr3b`. Show sections 3.1,
  4 and 5, and payable, each a small table of buckets
  `{taxablePaise?, igstPaise, cgstPaise, sgstPaise, cessPaise}`.
- **`/reports/hsn?kind=&from=&to=`:** `GET /reports/hsn`.
- **`/reports/register?kind=sales|purchase&from=&to=`:**
  `GET /reports/register`. Columns: number (link), date, return (bool),
  party, GSTIN, place of supply, RCM, taxable, the taxes, and total.
- **`/reports/tds?from=&to=`:** `GET /reports/tds`. It returns:
  - `deducted[]`: section, party, PAN, paid, TDS, and documents;
  - `deductedPaise`;
  - `deductedByOthers[]`: our receipts with TDS;
  - `rowsWithoutPan`: warn when > 0, because the higher rate applies.

---

## K. Checklist for each page

- [ ] `roles` match §0.4. A page never relies on its roles for safety, since
      the engine checks again.
- [ ] Every select uses `choices()` keys. No hard-coded ids.
- [ ] Money and quantity fields post strings, and displays use
      `money`/`fc()`/`qty()`.
- [ ] Every document record uses `docRecord()` with the right `entity` and
      `idField`.
- [ ] List pages: tabs via `links`, filters via a GET form, row link to the
      record.
- [ ] Reports: GET filter, `fixedOrder` where order is meaning, `footer`
      totals, a CSV link where offered.
- [ ] Empty states: an `empty` sentence on every table.
- [ ] After building: add the page paths to the web host's smoke test, if
      one lists module pages, and run `pnpm test` in `campusos-web`.
