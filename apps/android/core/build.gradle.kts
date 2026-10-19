// Pure Kotlin logic shared by the app and testable on the JVM: form validation, upload state.
plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

dependencies {
    api(project(":api"))
    implementation(libs.tus.java.client)
    implementation(libs.kotlinx.coroutines.core)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}

tasks.test {
    useJUnit()
    // The shared conformance suite is read from the repository, never copied into this module.
    systemProperty("conformance.dir", rootProject.layout.projectDirectory.dir("../../tools/acceptance/form-conformance").asFile.absolutePath)
    systemProperty("conformance.out", layout.buildDirectory.dir("form-conformance").get().asFile.absolutePath)
    testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
