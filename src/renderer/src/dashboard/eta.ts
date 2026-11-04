import type { JobState } from '../../../shared/types'

export interface EtaSample {
  t: number
  items: number
  videos: number
}

/** Videos finished plus the fraction of the ones downloading now. */
export function videoWork(job: Pick<JobState, 'videosDone' | 'videos'>): number {
  const frac = job.videos.reduce((n, v) => n + Math.min(1, Math.max(0, v.pct) / 100), 0)
  return job.videosDone + frac
}

/**
 * Seconds left for the whole job, from the recent pace.
 * Items and videos run together, so the wait is whichever finishes last.
 * Lessons still to open are counted as more videos, at the rate seen so far.
 */
export function estimateLeft(samples: EtaSample[], job: Pick<JobState, 'done' | 'total' | 'videosDone' | 'videosTotal' | 'videos'>): number | null {
  if (samples.length < 2) return null
  const a = samples[0]
  const b = samples[samples.length - 1]
  const dt = (b.t - a.t) / 1000
  if (dt < 8) return null
  const itemRate = (b.items - a.items) / dt
  const videoRate = (b.videos - a.videos) / dt

  const remainingItems = Math.max(0, (job.total || 0) - job.done)
  const activeFrac = job.videos.reduce((n, v) => n + Math.min(1, Math.max(0, v.pct) / 100), 0)
  const discoveredLeft = Math.max(0, job.videosTotal - job.videosDone - activeFrac)
  // One slow start must not be multiplied into every lesson still to open.
  const seenVideoPace = b.videos - a.videos >= 0.5
  const project = seenVideoPace && job.total > 0 && remainingItems > 0 && job.done >= 1 && job.videosTotal > 0
  const future = project ? remainingItems * (job.videosTotal / job.done) : 0
  const videoLeft = discoveredLeft + future

  let eta = 0
  if (remainingItems > 0) {
    if (itemRate <= 0.01) return null
    eta = remainingItems / itemRate
  }
  if (videoLeft > 0.05) {
    if (videoRate <= 0.002) return null
    eta = Math.max(eta, videoLeft / videoRate)
  }
  if (!(eta > 1) || eta > 72 * 3600) return null
  return eta
}

export function formatLeft(seconds: number): string {
  const s = Math.max(1, seconds)
  if (s < 90) return `~${Math.max(5, Math.round(s / 5) * 5)}s left`
  const min = Math.round(s / 60)
  if (min < 60) return `~${min} min left`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `~${h} h ${m} min left` : `~${h} h left`
}
