// Result cards for the criteria that need a person with physical devices. Each rule knows which fields a filled card
// must carry, how to judge it, and what measurement it becomes. Judging is deliberately mechanical: a card cannot
// pass by being vague, and a blank is a refusal, not a fail.

const present = (v) => v !== null && v !== undefined && v !== "";
const num = (v) => typeof v === "number" && Number.isFinite(v);

function base(card, name) {
  const missing = [];
  if (card.card_version !== 1) missing.push("card_version must be 1");
  if (card.test_name !== name) missing.push(`test_name must be ${name}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(card.performed_on ?? "")) missing.push("performed_on (YYYY-MM-DD)");
  return missing;
}

export const RULES = {
  "task-killers": {
    slug: (c) => c.device.vendor,
    validate(card) {
      const missing = base(card, "task-killers");
      if (!["xiaomi", "samsung"].includes(card.device?.vendor)) missing.push("device.vendor (xiaomi|samsung)");
      for (const k of ["model", "os_version"]) if (!card.device?.[k]) missing.push(`device.${k}`);
      if (!card.app_version) missing.push("app_version");
      if (!/^[0-9a-f]{64}$/.test(card.upload?.file_sha256 ?? "")) missing.push("upload.file_sha256");
      for (const k of ["onboarding_completed", "battery_percent_at_start", "locked_minutes", "interventions_before_complete", "completed"]) if (!present(card.steps?.[k])) missing.push(`steps.${k}`);
      if (card.steps?.completed === true && !present(card.steps?.server_sha256_match)) missing.push("steps.server_sha256_match (required once the upload completed)");
      return missing;
    },
    judge(card) {
      const s = card.steps, reasons = [];
      if (!s.onboarding_completed) reasons.push("onboarding not completed");
      if (s.locked_minutes < 30) reasons.push(`locked only ${s.locked_minutes} min`);
      if (s.interventions_before_complete > 0) reasons.push(`${s.interventions_before_complete} intervention(s) before completion`);
      if (!s.completed) reasons.push("upload did not complete");
      else if (s.server_sha256_match !== true) reasons.push("server SHA-256 differs");
      return {
        reasons,
        metrics: { vendor: card.device.vendor, app_version: card.app_version, locked_minutes: s.locked_minutes, interventions_before_complete: s.interventions_before_complete, completed: s.completed, completed_minutes_after_start: s.completed_minutes_after_start ?? "n/a", sha256_match: s.server_sha256_match ?? "n/a", battery_percent_at_start: s.battery_percent_at_start },
        platform: "android", file: { size_bytes: card.upload.file_size_bytes ?? 1073741824 }, network: { profile: card.network?.type ?? "field" }, upload_path: card.upload.path ?? "tusd",
        okNote: "نجح هذا الجهاز؛ المعيار يعبر حين تنجح بطاقتا Xiaomi وSamsung معًا، فهذه النتيجة جزئية للمعيار",
      };
    },
  },

  "force-quit-restart": {
    slug: (c) => `${c.device.platform}-${c.device.vendor}`,
    SCENARIOS: ["force_quit", "battery_depleted", "reboot", "low_storage"],
    validate(card) {
      const missing = base(card, "force-quit-restart");
      if (!["ios", "android"].includes(card.device?.platform)) missing.push("device.platform (ios|android)");
      for (const k of ["vendor", "model", "os_version"]) if (!card.device?.[k]) missing.push(`device.${k}`);
      if (!card.app_version) missing.push("app_version");
      if (!/^[0-9a-f]{64}$/.test(card.upload?.file_sha256 ?? "")) missing.push("upload.file_sha256");
      if (!num(card.upload?.part_size_bytes)) missing.push("upload.part_size_bytes");
      // optional: the phone's own PATCH payload when it differs from the server's part size (iOS background sessions send 64 MiB or more)
      if (card.upload?.request_bytes !== undefined && !num(card.upload.request_bytes)) missing.push("upload.request_bytes (a number, or leave it out)");
      for (const sc of this.SCENARIOS) {
        const s = card.scenarios?.[sc];
        if (!s) { missing.push(`scenarios.${sc}`); continue; }
        for (const k of ["offset_before_bytes", "offset_after_resume_bytes", "completed", "interventions_after_restart"]) if (!present(s[k])) missing.push(`scenarios.${sc}.${k}`);
        if (s.completed === true && !present(s.server_sha256_match)) missing.push(`scenarios.${sc}.server_sha256_match`);
      }
      if (!num(card.scenarios?.low_storage?.free_storage_mb_at_start)) missing.push("scenarios.low_storage.free_storage_mb_at_start");
      return missing;
    },
    judge(card) {
      const part = card.upload.part_size_bytes, reasons = [], metrics = {};
      // the largest legitimate step back is one request in flight: the phone's request size when recorded, else the server part size
      const request = card.upload.request_bytes ?? part;
      for (const sc of this.SCENARIOS) {
        const s = card.scenarios[sc];
        // "resume from what arrived": the server offset after the restart may fall back by at most one request, never to zero
        const regressed = s.offset_before_bytes - s.offset_after_resume_bytes;
        if (s.offset_before_bytes > 0 && s.offset_after_resume_bytes === 0) reasons.push(`${sc}: restarted from zero`);
        else if (regressed > request) reasons.push(`${sc}: went back ${regressed} bytes, more than one request (${request})`);
        if (!s.completed) reasons.push(`${sc}: did not complete`);
        else if (s.server_sha256_match !== true) reasons.push(`${sc}: server SHA-256 differs`);
        if (s.interventions_after_restart > 0) reasons.push(`${sc}: ${s.interventions_after_restart} intervention(s) after the restart`);
        metrics[`${sc}_regressed_bytes`] = regressed;
        metrics[`${sc}_completed`] = Boolean(s.completed);
      }
      if (card.scenarios.low_storage.free_storage_mb_at_start >= 1024) reasons.push(`low_storage: ${card.scenarios.low_storage.free_storage_mb_at_start} MB free is not under 1 GB`);
      return {
        reasons, metrics: { platform: card.device.platform, vendor: card.device.vendor, app_version: card.app_version, part_size_bytes: part, request_bytes: request, ...metrics },
        platform: card.device.platform, file: { size_bytes: card.upload.file_size_bytes ?? 0 }, network: { profile: card.network?.type ?? "field" }, upload_path: card.upload.path ?? "tusd",
        okNote: "نجح هذا الجهاز بسيناريوهاته الأربعة؛ المعيار يحتاج جهاز iOS وأندرويد فعليين على الأقل، فهذه النتيجة جزئية للمعيار",
      };
    },
  },

  "emergency-wipe": {
    slug: (c) => `${c.device.platform}-${c.device.vendor}`,
    // the stores each app documents (iOS: ADR 0009 section 3 / #56; Android: DeviceWipe.kt / #57); a card lists exactly its platform's
    STORES: {
      ios: ["server_sessions", "session", "upload_tokens", "upload_state", "chunks", "imported_originals", "caches", "temporary", "url_cache", "defaults", "background_transfers"],
      android: ["server_sessions", "transfers", "session", "upload_queue", "file_grants", "preferences", "caches_and_files"],
    },
    WIPE_MAX_S: 5,
    validate(card) {
      const missing = base(card, "emergency-wipe");
      if (!["ios", "android"].includes(card.device?.platform)) missing.push("device.platform (ios|android)");
      for (const k of ["vendor", "model", "os_version"]) if (!card.device?.[k]) missing.push(`device.${k}`);
      if (!card.app_version) missing.push("app_version");
      if (!num(card.setup?.upload_progress_pct_at_wipe)) missing.push("setup.upload_progress_pct_at_wipe");
      for (const k of ["seconds", "server_sessions_listed_empty", "old_access_token_refused"]) if (!present(card.online_wipe?.[k])) missing.push(`online_wipe.${k}`);
      if (!present(card.offline_wipe?.seconds)) missing.push("offline_wipe.seconds");
      for (const k of ["works_without_restart", "new_material_works"]) if (!present(card.relogin?.[k])) missing.push(`relogin.${k}`);
      const want = this.STORES[card.device?.platform] ?? [];
      for (const st of want) {
        const e = card.stores?.[st];
        if (!e || !present(e.empty)) missing.push(`stores.${st}.empty`);
        else if (!e.checked_with) missing.push(`stores.${st}.checked_with (the command or screen used)`);
      }
      for (const st of Object.keys(card.stores ?? {})) if (!want.includes(st)) missing.push(`stores.${st} is not a store of ${card.device?.platform}`);
      return missing;
    },
    judge(card) {
      const reasons = [], want = this.STORES[card.device.platform];
      for (const st of want) if (card.stores[st].empty !== true) reasons.push(`${st}: not empty after the wipe`);
      if (card.online_wipe.seconds > this.WIPE_MAX_S) reasons.push(`online wipe took ${card.online_wipe.seconds} s (limit ${this.WIPE_MAX_S})`);
      if (card.offline_wipe.seconds > this.WIPE_MAX_S) reasons.push(`offline wipe took ${card.offline_wipe.seconds} s (limit ${this.WIPE_MAX_S})`);
      if (card.online_wipe.server_sessions_listed_empty !== true) reasons.push("the server still lists a session of the wiped device");
      if (card.online_wipe.old_access_token_refused !== true) reasons.push("the old access token is still accepted");
      if (card.relogin.works_without_restart !== true || card.relogin.new_material_works !== true) reasons.push("sign-in after the wipe does not work without restarting the app");
      return {
        reasons,
        metrics: { platform: card.device.platform, vendor: card.device.vendor, app_version: card.app_version, upload_progress_pct_at_wipe: card.setup.upload_progress_pct_at_wipe, online_wipe_s: card.online_wipe.seconds, offline_wipe_s: card.offline_wipe.seconds, wipe_limit_s: this.WIPE_MAX_S, stores_checked: want.length, stores_empty: want.filter((st) => card.stores[st].empty === true).length, old_token_refused: card.online_wipe.old_access_token_refused === true },
        platform: card.device.platform, file: {}, network: { profile: "field" }, upload_path: "tusd",
        okNote: "نجح هذا الجهاز؛ المعيار يحتاج جهاز iOS وأندرويد فعليين، فهذه النتيجة جزئية للمعيار",
      };
    },
  },

  "timestamp-alignment": {
    slug: () => "ten-files",
    validate(card) {
      const missing = base(card, "timestamp-alignment");
      if (!card.measured_by) missing.push("measured_by (the alignment tool and its version)");
      if (!Array.isArray(card.files) || card.files.length < 10) missing.push("files (at least 10 entries)");
      (card.files ?? []).forEach((f, i) => {
        for (const k of ["model", "vfr", "has_gaps", "offset_ms"]) if (!present(f[k])) missing.push(`files[${i}].${k}`);
      });
      return missing;
    },
    judge(card) {
      const reasons = [], offs = card.files.map((f) => Math.abs(f.offset_ms)).sort((a, b) => a - b);
      card.files.forEach((f, i) => {
        if (f.vfr !== true) reasons.push(`files[${i}]: not variable frame rate`);
        if (f.has_gaps !== true) reasons.push(`files[${i}]: no time gaps`);
        if (Math.abs(f.offset_ms) > 40) reasons.push(`files[${i}]: offset ${f.offset_ms} ms exceeds 40 ms`);
      });
      return {
        reasons, passIsFull: true,
        metrics: { files: card.files.length, offset_ms_max: offs.at(-1), offset_ms_p50: offs[Math.floor(offs.length / 2)], offset_ms_limit: 40, vfr_files: card.files.filter((f) => f.vfr).length, files_with_gaps: card.files.filter((f) => f.has_gaps).length, measured_by: card.measured_by },
        platform: "other", file: {}, network: { profile: "n/a" }, upload_path: "n/a",
        okNote: "عشرة ملفات هاتف بمعدل إطارات متغير وفجوات، كل إزاحاتها ضمن 40 مللي ثانية",
      };
    },
  },
};
