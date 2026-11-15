package net.palpost.library

import android.app.LocaleManager
import android.graphics.Bitmap
import android.os.Build
import android.os.LocaleList
import android.view.WindowManager
import androidx.test.core.app.ActivityScenario
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import net.palpost.library.ui.MainActivity
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.URI

/** اختبار اختياري على محاكي قابل للإزالة؛ لا يغيّر منع اللقطات في التطبيق. */
@RunWith(AndroidJUnit4::class)
class StoreScreenshotsTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext

    private fun waitText(value: String) {
        compose.waitUntil(30_000) {
            compose.onAllNodes(hasText(value)).fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test fun captureSeededScreens() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Optional store capture", args.getString("storeCapture") == "1")
        check(BuildConfig.DEBUG && Build.VERSION.SDK_INT >= 33) { "Debug API 33+ required" }
        check(Build.HARDWARE in setOf("ranchu", "goldfish")) { "Disposable emulator required" }
        val api = URI(BuildConfig.API_BASE_URL)
        check(api.scheme == "http" && api.host == "localhost") { "Local reversed API required" }
        val locale = args.getString("captureLocale") ?: error("captureLocale required")
        check(locale in setOf("ar", "en-US"))
        val credentials = File(context.filesDir, "store-capture.json")
        val app = context.applicationContext as PostHistoryApp
        var scenario: ActivityScenario<MainActivity>? = null
        val oldLocales = context.getSystemService(LocaleManager::class.java).applicationLocales
        try {
            val input = JSONObject(credentials.readText())
            check(input.optBoolean("synthetic")) { "Synthetic consent required" }
            // لا تظهر الاعتمادات في اسم الاختبار أو وسيطات instrumentation أو رسائل فشله.
            val materialTitle = try {
                runBlocking {
                    app.container.auth.login(input.getString("email"), input.getString("password"), null)
                    val me = app.container.authApi.getMe()
                    check(me.email == input.getString("email"))
                    app.container.notificationsApi.listNotifications(cursor = null, limit = 50)
                    val page = app.container.materialsApi.listMaterials(limit = 20)
                    check(page.items.isNotEmpty())
                    check(page.items.all { it.title.contains("اصطناعي") })
                    page.items.first().title
                }
            } catch (_: Exception) { error("Synthetic seed login or material preflight failed") }
            credentials.delete()
            context.getSystemService(LocaleManager::class.java).applicationLocales = LocaleList.forLanguageTags(locale)
            app.container.settings.taskKillerSetupDone = true
            scenario = ActivityScenario.launch(MainActivity::class.java)
            val active = checkNotNull(scenario)
            active.onActivity {
                check(it.resources.configuration.locales[0].language == locale.substringBefore("-"))
                check(it.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                // الاستثناء موجود في androidTest وحده، بعد فحص debug والمحاكي والبيانات الاصطناعية.
                it.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
            val output = File(context.filesDir, "store-captures").apply { mkdirs() }
            fun label(id: Int): String {
                var value = ""
                active.onActivity { value = it.getString(id) }
                return value
            }
            fun capture(name: String, ready: String) {
                waitText(ready)
                compose.waitForIdle()
                instrumentation.waitForIdleSync()
                val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
                check(bitmap.width >= 1080 && bitmap.height >= 1920) { "Screenshot below required dimensions" }
                File(output, "$name.png").outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
                bitmap.recycle()
            }
            val home = label(R.string.home_title)
            waitText(home)
            // ننتظر جواب الحساب أيضًا قبل التقاط الشاشة الرئيسية.
            compose.waitUntil(30_000) {
                compose.onAllNodes(hasText(label(R.string.home_loading))).fetchSemanticsNodes().isEmpty()
            }
            capture("01-home", home)
            fun visit(action: Int, name: String, ready: () -> String) {
                compose.onNodeWithText(label(action)).performClick()
                waitText(ready())
                if (action == R.string.home_notifications) {
                    val loading = label(R.string.notifications_loading)
                    compose.waitUntil(30_000) {
                        compose.onAllNodes(hasText(loading)).fetchSemanticsNodes().isEmpty()
                    }
                }
                capture(name, ready())
                active.onActivity { it.onBackPressedDispatcher.onBackPressed() }
                waitText(home)
            }
            visit(R.string.home_materials, "02-materials") { materialTitle }
            visit(R.string.home_new_material, "03-new-material") { label(R.string.a1_pick_gallery) }
            visit(R.string.home_uploads, "04-uploads") { label(R.string.uploads_empty) }
            visit(R.string.home_notifications, "05-notifications") { label(R.string.notifications_title) }
        } finally {
            scenario?.onActivity { it.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) }
            scenario?.close()
            runBlocking { runCatching { app.container.auth.logout() } }
            credentials.delete()
            context.getSystemService(LocaleManager::class.java).applicationLocales = oldLocales
        }
    }
}
