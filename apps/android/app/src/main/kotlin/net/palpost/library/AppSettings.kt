package net.palpost.library

import android.content.Context

/** Non-sensitive preferences (flags only; nothing here identifies a person, a place or a device). */
class AppSettings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var taskKillerSetupDone: Boolean
        get() = prefs.getBoolean(KEY_TASK_KILLER_SETUP, false)
        set(value) { prefs.edit().putBoolean(KEY_TASK_KILLER_SETUP, value).apply() }

    /** Generated on first use, never derived from device identifiers (contract: PushDeviceRegistration). */
    val installationId: String
        get() = prefs.getString(KEY_INSTALLATION, null) ?: java.util.UUID.randomUUID().toString().also { prefs.edit().putString(KEY_INSTALLATION, it).apply() }

    /** The reporter paused the queue (A2): no transfer starts or continues until they resume. */
    var uploadsPaused: Boolean
        get() = prefs.getBoolean(KEY_PAUSED, false)
        set(value) { prefs.edit().putBoolean(KEY_PAUSED, value).commit() }

    /** Transfers only on an unmetered network (A2 "Wi-Fi only"). */
    var uploadOverWifiOnly: Boolean
        get() = prefs.getBoolean(KEY_WIFI_ONLY, false)
        set(value) { prefs.edit().putBoolean(KEY_WIFI_ONLY, value).commit() }

    private companion object {
        const val KEY_PAUSED = "uploads_paused"
        const val KEY_WIFI_ONLY = "upload_over_wifi_only"
        const val KEY_TASK_KILLER_SETUP = "task_killer_setup_done"
        const val KEY_INSTALLATION = "installation_id"
    }
}
