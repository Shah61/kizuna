/**
 * Resolves "whatever is currently selected" into the shapes the rest of the
 * game already understands.
 *
 * Only MP3s discovered in content/music are selectable. Each becomes a
 * SongSpec for display and a Chart derived from its cached audio analysis.
 */

import type { SongSpec, Difficulty } from '../data/songs';
import { customToSongSpec, type CustomTrack } from '../data/library';
import type { Chart } from './composer';
import { chartFromAnalysis } from '../audio/analyzer';
import { DEFAULT_LANE_COUNT, type LaneCount } from './lanes';

export interface Selection {
  song: SongSpec;
  track: CustomTrack;
}

export function resolveSelection(songId: string, tracks: CustomTrack[]): Selection | null {
  const musicTracks = tracks.filter((track) => track.source === 'music-folder');
  const track = musicTracks.find((candidate) => candidate.id === songId) ?? musicTracks[0];
  return track ? { song: customToSongSpec(track), track } : null;
}

/** Folder charts are cheap to rebuild, so they are memoised here. */
const customChartCache = new Map<string, Chart>();

export function chartFor(
  selection: Selection,
  difficulty: Difficulty,
  laneCount: LaneCount = DEFAULT_LANE_COUNT,
): Chart {
  const { track } = selection;

  const key = `${track.id}:${difficulty.id}:${track.addedAt}:${laneCount}`;
  let chart = customChartCache.get(key);
  if (!chart) {
    chart = chartFromAnalysis(track.analysis, difficulty, track.id, laneCount);
    customChartCache.set(key, chart);
  }
  return chart;
}

/** Every MP3 discovered in content/music, newest analysis first. */
export function allPlayables(tracks: CustomTrack[]): Selection[] {
  return tracks
    .filter((track) => track.source === 'music-folder')
    .map((track) => ({ song: customToSongSpec(track), track }));
}
