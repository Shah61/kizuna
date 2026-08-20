/**
 * Importing audio from disk.
 *
 * Electron exposes the MP3 files in content/music as raw bytes. Analysis is
 * cached in settings while decoded audio is cached for the current session.
 */

import type { SynthEngine } from './synth';
import { analyzeTrack, type AnalysisProgress } from './analyzer';
import {
  compactAnalysis,
  trackIdFor,
  type CustomTrack,
} from '../data/library';

/** Decoded audio, keyed by track id, so replays never re-read the file. */
const audioCache = new Map<string, AudioBuffer>();

export const cachedAudio = (id: string): AudioBuffer | undefined => audioCache.get(id);

export interface ImportProgress extends AnalysisProgress {
  /** 1-based position in this batch. */
  index: number;
  total: number;
  title: string;
}

export interface ScannedFile {
  path: string;
  name: string;
  source: 'music-folder';
}

/** MP3 audio sitting in the shipped content/music folder. */
export async function scanMusicFolders(): Promise<ScannedFile[]> {
  if (!window.kizuna?.scanMusic) return [];
  try {
    return await window.kizuna.scanMusic();
  } catch {
    return [];
  }
}

/**
 * Analyse a known list of paths — used for the folder scan, where there is no
 * picker involved. Anything that fails is skipped, not fatal to the batch.
 */
export async function importFromPaths(
  synth: SynthEngine,
  files: ScannedFile[],
  onProgress: (p: ImportProgress) => void,
  onError?: (name: string, message: string) => void,
): Promise<CustomTrack[]> {
  const out: CustomTrack[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const report = (p: AnalysisProgress) =>
      onProgress({ ...p, index: i + 1, total: files.length, title: file.name });

    try {
      report({ phase: 'decoding', value: 0 });
      const bytes = await window.kizuna!.readAudio(file.path);
      const audio = await synth.ctx.decodeAudioData(bytes.slice(0));
      const analysis = await analyzeTrack(audio, report);
      const id = trackIdFor(file.path);
      audioCache.set(id, audio);

      out.push({
        id,
        path: file.path,
        title: file.name,
        duration: audio.duration,
        bpm: analysis.bpm,
        addedAt: Date.now(),
        analysis: compactAnalysis(analysis),
        source: 'music-folder',
      });
    } catch (err) {
      onError?.(file.name, err instanceof Error ? err.message : String(err));
    }
  }

  return out;
}

/**
 * Get the decoded audio for a track, reading it back off disk if this is the
 * first play since launch. Throws if the file has moved or been deleted.
 */
export async function loadTrackAudio(
  synth: SynthEngine,
  track: CustomTrack,
): Promise<AudioBuffer> {
  const hit = audioCache.get(track.id);
  if (hit) return hit;

  if (!window.kizuna) {
    throw new Error('Re-import this track — browser imports do not survive a reload.');
  }

  const bytes = await window.kizuna.readAudio(track.path);
  const audio = await synth.ctx.decodeAudioData(bytes.slice(0));
  audioCache.set(track.id, audio);
  return audio;
}
