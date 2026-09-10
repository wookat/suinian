package com.zalize.suinian.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class TzSyncMarkerTest {

    @Test
    fun `same token and zone yields same marker`() {
        assertEquals(tzSyncMarker("sn_abcdefgh_rest", "Asia/Shanghai"), tzSyncMarker("sn_abcdefgh_other", "Asia/Shanghai"))
        assertEquals("sn_abcde:Asia/Shanghai", tzSyncMarker("sn_abcdefgh", "Asia/Shanghai"))
    }

    @Test
    fun `zone change or account change invalidates marker`() {
        assertNotEquals(tzSyncMarker("sn_abcdefgh", "Asia/Shanghai"), tzSyncMarker("sn_abcdefgh", "America/New_York"))
        assertNotEquals(tzSyncMarker("sn_abcdefgh", "Asia/Shanghai"), tzSyncMarker("sn_zzzzzzzz", "Asia/Shanghai"))
    }

    @Test
    fun `short token does not throw`() {
        assertEquals("ab:UTC", tzSyncMarker("ab", "UTC"))
    }
}
