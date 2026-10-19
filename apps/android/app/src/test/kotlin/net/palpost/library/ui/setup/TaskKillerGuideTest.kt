package net.palpost.library.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Test

class TaskKillerGuideTest {
    @Test fun `manufacturer strings map to the vendors the field test targets`() {
        assertEquals(Vendor.XIAOMI, TaskKillerGuide.vendor("Xiaomi", "Redmi"))
        assertEquals(Vendor.XIAOMI, TaskKillerGuide.vendor("Xiaomi", "POCO"))
        assertEquals(Vendor.SAMSUNG, TaskKillerGuide.vendor("samsung", "samsung"))
        assertEquals(Vendor.HUAWEI, TaskKillerGuide.vendor("HUAWEI", "HONOR"))
        assertEquals(Vendor.OPPO, TaskKillerGuide.vendor("OnePlus", "OnePlus"))
        assertEquals(Vendor.OPPO, TaskKillerGuide.vendor("realme", "realme"))
        assertEquals(Vendor.VIVO, TaskKillerGuide.vendor("vivo", "iQOO"))
        assertEquals(Vendor.OTHER, TaskKillerGuide.vendor("Google", "google"))
    }
}
