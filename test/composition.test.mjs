import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captionEvents,
  circleAnchor,
  layoutAudioPolicy,
  timelineSegments,
} from '../src/composition/editorial-grammar.mjs';
import {
  selectDialogueWords,
  sourceVideoTrimProps,
} from '../src/composition/media-grammar.mjs';

test('groups Korean captions into at most two short lines', () => {
  const events = captionEvents([
    { word: '오늘', start: 0, end: 0.3 },
    { word: '꼭', start: 0.3, end: 0.5 },
    { word: '알아야', start: 0.5, end: 0.9 },
    { word: '할', start: 0.9, end: 1.1 },
    { word: '인공지능', start: 1.1, end: 1.5 },
    { word: '소식입니다', start: 1.5, end: 2 },
  ], 30);

  assert.ok(events.every((event) => event.lines.length <= 2));
  assert.ok(events.every((event) => event.lines.every((line) => line.length <= 16)));
  assert.equal(events[0].startFrame, 0);
  assert.ok(events.every((event) => event.endFrame - event.startFrame >= 12));
});

test('uses lower-obstruction approved circular face anchor', () => {
  assert.equal(
    circleAnchor({ leftEdgeScore: 0.72, rightEdgeScore: 0.21 }),
    'middle-right',
  );
  assert.equal(
    circleAnchor({ leftEdgeScore: 0.12, rightEdgeScore: 0.64 }),
    'middle-left',
  );
  assert.equal(
    circleAnchor({ leftEdgeScore: 0.5, rightEdgeScore: 0.5 }),
    'middle-right',
  );
});

test('compacts source ranges into a gap-free output timeline', () => {
  const timeline = timelineSegments({
    segments: [
      { id: 'segment_001', startFrame: 0, endFrame: 90 },
      { id: 'segment_002', startFrame: 150, endFrame: 240 },
    ],
  });

  assert.deepEqual(
    timeline.map(({ outputStartFrame, durationInFrames }) => ({
      outputStartFrame,
      durationInFrames,
    })),
    [
      { outputStartFrame: 0, durationInFrames: 90 },
      { outputStartFrame: 90, durationInFrames: 90 },
    ],
  );
});

test('keeps explicit source and output ranges for long-form timeline segments', () => {
  const timeline = timelineSegments({
    mode: 'longform-condense',
    segments: [{
      id: 'source_clip_001',
      sourceStartFrame: 300,
      sourceEndFrame: 900,
      outputStartFrame: 0,
      outputEndFrame: 600,
      durationInFrames: 600,
    }],
  });
  assert.deepEqual(timeline[0], {
    id: 'source_clip_001',
    sourceStartFrame: 300,
    sourceEndFrame: 900,
    outputStartFrame: 0,
    outputEndFrame: 600,
    durationInFrames: 600,
  });
});

test('keeps facecam dialogue audio in every approved layout', () => {
  for (const layout of [
    'face-full',
    'visual-full-face-circle',
    'screen-full-face-circle',
    'visual-full',
    'title-card',
  ]) {
    assert.equal(layoutAudioPolicy(layout), 'facecam-dialogue');
  }
});

test('uses source dialogue audio for long-form source layouts', () => {
  assert.equal(layoutAudioPolicy('source-full', { mode: 'longform-condense' }), 'source-dialogue');
});

test('maps source clip frames to current Remotion trim props', () => {
  assert.deepEqual(
    sourceVideoTrimProps({ sourceStartFrame: 300, sourceEndFrame: 900 }, 3_600),
    { trimBefore: 300, trimAfter: 2_700 },
  );
});

test('omits zero trimAfter at the end of the source video', () => {
  assert.deepEqual(
    sourceVideoTrimProps({ sourceStartFrame: 30, sourceEndFrame: 60 }, 60),
    { trimBefore: 30 },
  );
});

test('uses English source words for long-form captions without changing old mode', () => {
  const sourceWords = [{ word: 'English', start: 1, end: 2 }];
  const koreanWords = [{ word: '한국어', start: 1, end: 2 }];
  assert.deepEqual(
    selectDialogueWords({
      mode: 'longform-condense',
      sourceTranscript: { words: sourceWords, koreanWords },
      transcript: { words: koreanWords },
    }),
    koreanWords,
  );
  assert.deepEqual(
    selectDialogueWords({
      mode: 'longform-condense',
      sourceTranscript: { words: sourceWords },
      transcript: { words: koreanWords },
    }),
    [],
  );
  assert.deepEqual(
    selectDialogueWords({
      mode: 'facecam',
      sourceTranscript: { words: sourceWords },
      transcript: { words: koreanWords },
    }),
    koreanWords,
  );
});
