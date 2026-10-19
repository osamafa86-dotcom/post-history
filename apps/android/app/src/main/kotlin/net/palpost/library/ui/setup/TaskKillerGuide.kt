package net.palpost.library.ui.setup

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.annotation.StringRes
import net.palpost.library.R

/** Manufacturers whose battery managers kill background transfers after the screen locks. */
enum class Vendor { XIAOMI, SAMSUNG, HUAWEI, OPPO, VIVO, OTHER }

/**
 * The per-manufacturer onboarding: which settings pages to open, in which order, and what to do there.
 * It never requests `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (Play policy); it opens the system list and
 * only reads back whether the exemption was granted. Component names are the vendors' settings activities
 * as shipped on current firmware; each has a fallback to the app's own details page.
 */
object TaskKillerGuide {
    data class Step(
        val id: String,
        @StringRes val title: Int,
        @StringRes val body: Int,
        /** Tried in order; empty means the step is instructions only. */
        val intents: List<Intent> = emptyList(),
        /** True when the app can read back whether the step is done. */
        val verifiable: Boolean = false,
    )

    fun vendor(manufacturer: String = android.os.Build.MANUFACTURER, brand: String = android.os.Build.BRAND): Vendor {
        val m = (manufacturer + " " + brand).lowercase()
        return when {
            listOf("xiaomi", "redmi", "poco").any { it in m } -> Vendor.XIAOMI
            "samsung" in m -> Vendor.SAMSUNG
            listOf("huawei", "honor").any { it in m } -> Vendor.HUAWEI
            listOf("oppo", "realme", "oneplus").any { it in m } -> Vendor.OPPO
            listOf("vivo", "iqoo").any { it in m } -> Vendor.VIVO
            else -> Vendor.OTHER
        }
    }

    fun isBatteryExempt(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) == true

    fun steps(context: Context, vendor: Vendor = vendor()): List<Step> {
        val pkg = context.packageName
        val steps = ArrayList<Step>()
        steps += Step(
            id = "battery",
            title = R.string.setup_battery_title,
            body = if (vendor == Vendor.SAMSUNG) R.string.setup_battery_body_samsung else R.string.setup_battery_body,
            intents = listOf(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)),
            verifiable = true,
        )
        when (vendor) {
            Vendor.XIAOMI -> {
                steps += Step(
                    "xiaomi_saver", R.string.setup_xiaomi_saver_title, R.string.setup_xiaomi_saver_body,
                    listOf(
                        Intent().setComponent(ComponentName("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"))
                            .putExtra("package_name", pkg).putExtra("package_label", context.getString(R.string.app_name)),
                    ),
                )
                steps += Step(
                    "autostart", R.string.setup_autostart_title, R.string.setup_autostart_body_xiaomi,
                    listOf(Intent().setComponent(ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"))),
                )
                steps += Step("lock_recents", R.string.setup_lock_title, R.string.setup_lock_body_xiaomi)
            }
            Vendor.SAMSUNG -> {
                steps += Step(
                    "sleeping_apps", R.string.setup_samsung_sleep_title, R.string.setup_samsung_sleep_body,
                    listOf(
                        Intent().setComponent(ComponentName("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity")),
                        Intent().setComponent(ComponentName("com.samsung.android.sm_cn", "com.samsung.android.sm.ui.battery.BatteryActivity")),
                    ),
                )
                steps += Step("lock_recents", R.string.setup_lock_title, R.string.setup_lock_body_samsung)
            }
            Vendor.HUAWEI -> {
                steps += Step(
                    "autostart", R.string.setup_autostart_title, R.string.setup_autostart_body_huawei,
                    listOf(
                        Intent().setComponent(ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")),
                        Intent().setComponent(ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity")),
                    ),
                )
                steps += Step("lock_recents", R.string.setup_lock_title, R.string.setup_lock_body_generic)
            }
            Vendor.OPPO -> {
                steps += Step(
                    "autostart", R.string.setup_autostart_title, R.string.setup_autostart_body_generic,
                    listOf(
                        Intent().setComponent(ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")),
                        Intent().setComponent(ComponentName("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity")),
                    ),
                )
                steps += Step("lock_recents", R.string.setup_lock_title, R.string.setup_lock_body_generic)
            }
            Vendor.VIVO -> {
                steps += Step(
                    "autostart", R.string.setup_autostart_title, R.string.setup_autostart_body_generic,
                    listOf(Intent().setComponent(ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"))),
                )
                steps += Step("lock_recents", R.string.setup_lock_title, R.string.setup_lock_body_generic)
            }
            Vendor.OTHER -> steps += Step("lock_recents", R.string.setup_lock_title, R.string.setup_lock_body_generic)
        }
        return steps
    }

    /** Opens the first intent the device can handle, else the app's own settings page. */
    fun open(context: Context, step: Step) {
        for (intent in step.intents) {
            try {
                context.startActivity(Intent(intent).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return
            } catch (e: ActivityNotFoundException) {
                // next candidate
            } catch (e: SecurityException) {
                // some firmware exports the activity but refuses outside callers
            }
        }
        context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
