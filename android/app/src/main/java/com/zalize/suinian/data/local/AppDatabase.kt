package com.zalize.suinian.data.local

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Delete
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

/** 离线/失败待重试的 note */
@Entity(tableName = "pending_notes")
data class PendingNote(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val source: String,
    val rawType: String,
    val content: String,
    val url: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
)

@Dao
interface PendingNoteDao {
    @Insert
    suspend fun insert(note: PendingNote): Long

    @Query("SELECT * FROM pending_notes ORDER BY createdAt ASC")
    suspend fun all(): List<PendingNote>

    @Query("SELECT COUNT(*) FROM pending_notes")
    fun count(): Flow<Int>

    @Delete
    suspend fun delete(note: PendingNote)
}

@Database(entities = [PendingNote::class], version = 1, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {
    abstract fun pendingNoteDao(): PendingNoteDao

    companion object {
        @Volatile private var instance: AppDatabase? = null

        fun get(context: Context): AppDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext, AppDatabase::class.java, "suinian.db"
            ).build().also { instance = it }
        }
    }
}
