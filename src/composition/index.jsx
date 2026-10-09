import React from 'react';
import {
  Composition,
  registerRoot,
} from 'remotion';
import { JuwonAiNewsVideo } from './Video.jsx';
import { timelineDuration } from './editorial-grammar.mjs';

const defaultPlan = {
  version: 1,
  jobId: 'video_default',
  fps: 30,
  durationFrames: 1,
  segments: [{
    id: 'segment_001',
    startFrame: 0,
    endFrame: 1,
    spokenText: '',
    layout: 'face-full',
    primaryAssetId: 'facecam_main',
    sourceId: null,
    captionStyle: 'none',
    confidence: 1,
    reason: 'default',
  }],
  warnings: [],
};

function Root() {
  return (
    <Composition
      id="JuwonAiNews"
      component={JuwonAiNewsVideo}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={1}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.max(1, timelineDuration(props.plan)),
      })}
      defaultProps={{
        plan: defaultPlan,
        transcript: { version: 1, language: 'ko', text: '', words: [] },
        sourceTranscript: { version: 1, language: 'en', durationSeconds: 0, words: [], segments: [] },
        mode: 'facecam',
        media: {},
        anchorMeasurements: {},
      }}
    />
  );
}

registerRoot(Root);
