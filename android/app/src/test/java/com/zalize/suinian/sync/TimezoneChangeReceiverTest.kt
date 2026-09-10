package com.zalize.suinian.sync

import org.junit.Assert.assertEquals
import org.junit.Test

class TimezoneChangeReceiverTest {

    @Test
    fun `uses the zone id carried by the broadcast`() {
        assertEquals("America/New_York", zoneIdFromTimezoneChange("America/New_York", "Asia/Shanghai"))
        assertEquals("UTC", zoneIdFromTimezoneChange(" UTC ", "Asia/Shanghai"))
    }

    @Test
    fun `falls back to the process default when the extra is absent or blank`() {
        assertEquals("Asia/Shanghai", zoneIdFromTimezoneChange(null, "Asia/Shanghai"))
        assertEquals("Asia/Shanghai", zoneIdFromTimezoneChange("", "Asia/Shanghai"))
        assertEquals("Asia/Shanghai", zoneIdFromTimezoneChange("   ", "Asia/Shanghai"))
    }

    @Test
    fun `falls back when the extra is not a known IANA id`() {
        assertEquals("Asia/Shanghai", zoneIdFromTimezoneChange("Mars/Olympus", "Asia/Shanghai"))
        assertEquals("Asia/Shanghai", zoneIdFromTimezoneChange("GMT+08:00 (China Standard Time)", "Asia/Shanghai"))
    }

    @Test
    fun `extra key matches the framework constant`() {
        assertEquals("time-zone", TimezoneChangeReceiver.EXTRA_TIMEZONE)
    }
}
