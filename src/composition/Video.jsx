import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
} from 'remotion';
import { CaptionLayer } from './captions.jsx';
import {
  captionEvents,
  timelineSegments,
} from './editorial-grammar.mjs';
import { SegmentLayout } from './layouts.jsx';
import { selectDialogueWords } from './media-grammar.mjs';

export function JuwonAiNewsVideo({
  plan,
  transcript,
  sourceTranscript,
  media,
  anchorMeasurements,
  mode,
}) {
  const timeline = timelineSegments(plan);
  const activeMode = mode || plan?.mode || 'facecam';
  const faceAsset = media?.facecam_main || {};
  const faceSrc = faceAsset.src
    || (faceAsset.staticPath ? staticFile(faceAsset.staticPath) : '');
  const sourceAsset = media?.source_main || media?.source_video || {};
  const sourceSrc = sourceAsset.src
    || (sourceAsset.staticPath ? staticFile(sourceAsset.staticPath) : '');
  const sourceDurationFrames = Number.isInteger(sourceAsset.durationFrames)
    ? sourceAsset.durationFrames
    : undefined;
  const dialogueWords = selectDialogueWords({
    mode: activeMode,
    sourceTranscript,
    transcript,
  });
  const musicAsset = media?.music_background || {};
  const music = musicAsset.src
    || (musicAsset.staticPath ? staticFile(musicAsset.staticPath) : '');

  return (
    <AbsoluteFill style={{ background: '#080d18' }}>
      {music ? <Audio src={music} volume={0.12} loop /> : null}
      {timeline.map((segment) => {
        const sourceStartSeconds = segment.sourceStartFrame / plan.fps;
        const sourceEndSeconds = segment.sourceEndFrame / plan.fps;
        const events = captionEvents(dialogueWords, plan.fps, {
          sourceStartSeconds,
          sourceEndSeconds,
          outputStartFrame: 0,
        });
        const measured = anchorMeasurements?.[segment.id] || {
          leftEdgeScore: 0,
          rightEdgeScore: 0,
        };
        return (
          <Sequence
            key={segment.id}
            from={segment.outputStartFrame}
            durationInFrames={segment.durationInFrames}
            name={segment.id}
          >
            <SegmentLayout
              segment={segment}
              faceSrc={faceSrc}
              sourceSrc={sourceSrc}
              sourceDurationFrames={sourceDurationFrames}
              primaryAsset={media?.[segment.primaryAssetId]}
              anchorScores={measured}
            />
            {segment.captionStyle === 'none'
              ? null
              : <CaptionLayer events={events} />}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
