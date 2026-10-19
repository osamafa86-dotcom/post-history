package net.palpost.library

import android.content.Context

/** Non-sensitive preferences (flags only; nothing here identifies a person, a place or a device). */
class AppSettings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var taskKillerSetupDone: Boolean
        get() = prefs.getBoolean(KEY_TASK_KILLER_SETUP, false)
        set(value) { prefs.edit().putBoolean(KEY_TASK_KILLER_SETUP, value).apply() }

    private companion object { const val KEY_TASK_KILLER_SETUP = "task_killer_setup_done" }
}
