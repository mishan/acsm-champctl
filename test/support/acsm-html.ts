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
  /** Rendered only when `renderEntrantId` is on — see write-path §2. */
  pitBox?: number
  internalUUID?: string
  /** An unpaired checkbox: omitted from the POST when unchecked. */
  overwriteAllEvents?: boolean
}

export interface FakeEventFormOptions {
  entrants: FakeEntrant[]
  /**
   * Whether the form renders `EntryList.EntrantID`. The public build does not
   * for championship events, which is the thing recon has to settle.
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
    renderEntrantId = false,
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
        <select name="EntryList.Skin"><option value="${e.skin}" selected="selected">${e.skin}</option></select>
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

/** The import page, whose only interesting feature is the file input's name. */
export function fakeImportPage(fileFieldName = "championshipFile"): string {
  return `<!doctype html><html><body>
    <form action="/championship/import" method="post" enctype="multipart/form-data">
      <input type="file" name="${fileFieldName}">
      <button type="submit">Import</button>
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
