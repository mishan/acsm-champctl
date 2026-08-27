/**
 * HTML shaped like ACSM's own templates.
 *
 * Reproduced from `cmd/server-manager/views/partials/race-builder/entrant.html`
 * at v1.7.9 — the field names, the readonly attributes on championship entrant
 * rows, the hidden InternalUUID and the unpaired checkboxes are all as ACSM
 * renders them. The parser has to cope with the real thing, not a tidy one.
 */

export interface FakeEntrant {
  name: string
  guid: string
  team?: string
  model: string
  skin: string
  ballast?: number
  restrictor?: number
  /** Rendered unless `renderEntrantId` is off — see docs/acsm-write-path.md §2. */
  pitBox?: number
  internalUUID?: string
  /** An unpaired checkbox: omitted from the POST when unchecked. */
  overwriteAllEvents?: boolean
}

export interface FakeEventFormOptions {
  entrants: FakeEntrant[]
  /**
   * Whether the form renders `EntryList.EntrantID`.
   *
   * Defaults to on, because that is what 1.7.9 measurably does: 24 of them for
   * 24 entrants (docs/acsm-write-path.md §2, which predicted the opposite and
   * was corrected). A fixture that omits it by default is a fixture no real
   * manager produces, and it quietly exempted the whole suite from the rule
   * that a POST must carry it.
   */
  renderEntrantId?: boolean
  /** Championship event rows render Name/Team/GUID readonly. */
  championshipEvent?: boolean
  action?: string
  raceLaps?: number
  raceTime?: number
  pitWindowStart?: number
}

export function fakeEventForm(options: FakeEventFormOptions): string {
  const {
    entrants,
    renderEntrantId = true,
    championshipEvent = true,
    action = "/championship/abc/event/submit",
    raceLaps = 20,
    raceTime = 0,
    pitWindowStart = 0,
  } = options

  const ro = championshipEvent ? ` readonly="readonly"` : ""

  const rows = entrants
    .map((e, i) => {
      const entrantId = renderEntrantId
        ? `<input type="number" name="EntryList.EntrantID" min="0" value="${e.pitBox ?? i}">`
        : ""
      const overwrite = championshipEvent
        ? `<input type="checkbox" name="EntryList.OverwriteAllEvents"${
            e.overwriteAllEvents ? ` checked="checked"` : ""
          }>`
        : ""
      return `
      <div class="card">
        ${entrantId}
        <input type="hidden" name="EntryList.InternalUUID" value="${e.internalUUID ?? `uuid-${i}`}">
        <input type="text" name="EntryList.Name" value="${e.name}"${ro}>
        <input type="text" name="EntryList.Team" value="${e.team ?? ""}"${ro}>
        <input type="text" name="EntryList.GUID" value="${e.guid}"${ro}>
        <select name="EntryList.Car"><option value="${e.model}" selected="selected">${e.model}</option></select>
        <select name="EntryList.Skin">${
          // An empty skin renders an option-less select, which is what 2.4.15
          // does for every `any_car_model` slot: the options are filled in by
          // JavaScript from the car's skin list, and the sentinel model has
          // none. Rendering a tidy `<option value="">` here instead would have
          // hidden the bug that made champctl POST a short EntryList.Skin
          // array and take a 500 from ACSM.
          e.skin === "" ? "" : `<option value="${e.skin}" selected="selected">${e.skin}</option>`
        }</select>
        <input type="number" name="EntryList.Ballast" value="${e.ballast ?? 0}">
        <input type="number" name="EntryList.Restrictor" value="${e.restrictor ?? 0}">
        <select name="EntryList.FixedSetup"><option value="">No Fixed Setup</option></select>
        ${overwrite}
      </div>`
    })
    .join("\n")

  return `<!doctype html>
<html><body>
<form action="${action}" method="post">
  <input type="hidden" name="Editing" value="event-1">
  <input type="hidden" name="action" value="saveChampionship">
  <input type="text" name="Track" value="suzuka">
  <select name="TrackLayout"><option value="" selected="selected">Default</option></select>
  <input type="number" name="MaxClients" value="18">
  <input type="number" name="Sessions.Race.Laps" value="${raceLaps}">
  <input type="number" name="Sessions.Race.Time" value="${raceTime}">
  <input type="number" name="RacePitWindowStart" value="${pitWindowStart}">
  <input type="checkbox" name="RaceExtraLap">
  <input type="checkbox" name="AllowDuplicateSkinChoices" checked="checked">
  <textarea name="Description">A description</textarea>
  <select name="Cars" multiple>
    <option value="rss_formula_hybrid_2021" selected="selected">RSS</option>
    <option value="ks_mazda_miata">Miata</option>
  </select>
  <input type="text" name="Disabled" value="nope" disabled>
  <input type="text" value="unnamed">
  <input type="file" name="championshipFile">
  ${rows}
  <button type="submit" name="submitButton" value="save">Save</button>
</form>
</body></html>`
}

export function fakeLoginPage(): string {
  return `<!doctype html><html><body>
    <form action="/login" method="post">
      <input type="text" name="Username">
      <input type="password" name="Password">
      <input type="checkbox" name="RememberMe">
    </form>
  </body></html>`
}

/**
 * The import page. Two shapes in the wild, and champctl has to tell them apart:
 * 1.7.9 renders a textarea and reads `r.FormValue("import")`; 2.4.5 renders a
 * file input and takes a multipart upload.
 *
 * Both include the navbar search form that every ACSM page carries, because
 * "the first form on the page" is how this went wrong the first time.
 */
export function fakeImportPage(
  kind: "file" | "textarea" = "file",
  fieldName = kind === "file" ? "championshipFile" : "import",
): string {
  const control =
    kind === "file"
      ? `<input type="file" name="${fieldName}">`
      : `<textarea name="${fieldName}" placeholder="Paste your championship JSON here!"></textarea>`
  const enctype = kind === "file" ? ` enctype="multipart/form-data"` : ""

  return `<!doctype html><html><body>
    <nav>
      <form action="/cars" method="get">
        <input type="text" name="q" value="">
        <button type="submit">Search</button>
      </form>
    </nav>
    <form method="post" action="/championship/import"${enctype}>
      ${control}
      <button type="submit">Save</button>
    </form>
  </body></html>`
}

/**
 * The event edit form, reduced to what finalize actually reads.
 *
 * Distinct from `fakeEventForm` above, which reproduces ACSM's own markup so
 * the *parser* has something realistic to cope with. This one is a script for
 * the plan/apply path: the scalar fields it mutates, an entry list long enough
 * for the fingerprint to have something to say, and the navbar search form in
 * front — because "the first form on the page" is how form-finding went wrong
 * the first time.
 *
 * Shared by `finalize.test.ts` and `web.test.ts` on purpose. Both drive the
 * same engine through the same endpoint, and two fixtures for one form is one
 * that gets corrected when ACSM changes and one that quietly stops matching.
 */
export interface FormEntrant {
  name: string
  guid: string
  pit: number
}

export function eventFormHtml(
  championshipId: string,
  entrants: readonly FormEntrant[],
  over: Record<string, string> = {},
): string {
  const base: Record<string, string> = {
    Track: "suzuka",
    "Race.Laps": "20",
    "Race.Time": "0",
    RacePitWindowStart: "0",
    ReversedGridRacePositions: "0",
    RaceExtraLap: "0",
    MaxClients: "18",
    ...over,
  }
  const scalars = Object.entries(base)
    .map(([k, v]) => `<input name="${k}" value="${v}">`)
    .join("")
  const list = entrants
    .map(
      (e) =>
        `<input name="EntryList.EntrantID" value="${e.pit}">` +
        `<input name="EntryList.Name" value="${e.name}">` +
        `<input name="EntryList.GUID" value="${e.guid}">` +
        `<input name="EntryList.Car" value="rss_formula_hybrid_2021">` +
        `<input name="EntryList.Skin" value="${e.name.toLowerCase()}_01">` +
        `<input name="EntryList.Team" value="">` +
        `<input name="EntryList.Ballast" value="0">` +
        `<input name="EntryList.Restrictor" value="0">` +
        `<input name="EntryList.FixedSetup" value="">` +
        `<input name="EntryList.InternalUUID" value="uuid-${e.pit}">`,
    )
    .join("")
  return `<html><body>
    <form action="/search" method="GET"><input name="q" value=""></form>
    <form action="/championship/${championshipId}/event/submit" method="POST">
      ${scalars}${list}
      <input name="EntryList.NumEntrants" value="${entrants.length}">
    </form>
  </body></html>`
}

export function scheduleFormHtml(
  championshipId: string,
  eventId: string,
  zone = "America/Los_Angeles",
  recurrence = "",
): string {
  return `<html><body>
    <form action="/search" method="GET"><input name="q" value=""></form>
    <form action="/championship/${championshipId}/event/${eventId}/schedule" method="POST">
      <input name="event-schedule-date" value="2026-09-02">
      <input name="event-schedule-time" value="19:00">
      <input name="event-schedule-timezone" value="${zone}">
      <input name="event-schedule-recurrence" value="${recurrence}">
    </form>
  </body></html>`
}

export function entrant(name: string, over: Partial<FakeEntrant> = {}): FakeEntrant {
  return {
    name,
    guid: `7656119${name.length}${name.charCodeAt(0)}`,
    model: "rss_formula_hybrid_2021",
    skin: `${name.toLowerCase()}_01`,
    ...over,
  }
}

/**
 * The `TrackLayout` select ACSM renders on an event edit form.
 *
 * The only place it says what layouts a track has. `<default>` is how it spells
 * a track with no choice — never mixed with real layouts, measured on 2.4.15.
 */
export function layoutSelectHtml(values: readonly string[]): string {
  const options = values
    .map(
      (v) =>
        `<option value="${v}" data-track-name="${v.split(":")[1]}">${v.split(":")[1]}</option>`,
    )
    .join("")
  return `<select class="form-control" name="TrackLayout" id="TrackLayout">${options}</select>`
}
