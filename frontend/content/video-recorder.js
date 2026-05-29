/**
 * Video recording utilities for content script
 * Video recording must be initiated from content script, not service worker
 */

class VideoRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.stream = null;
    this.isRecording = false;
  }

  async startRecording() {
    try {
      console.log('[video] ===== STARTING VIDEO RECORDING =====');
      console.log('[video] Current recording state:', this.isRecording);
      
      if (this.isRecording) {
        console.warn('[video] Already recording, returning early');
        return { ok: false, error: 'Already recording' };
      }
      
      console.log('[video] Requesting display media with preferCurrentTab...');
      
      // Request screen capture
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'browser',
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false,
        preferCurrentTab: true
      });

      console.log('[video] ✅ Got display media stream');
      console.log('[video] Stream tracks:', this.stream.getTracks().map(t => ({
        kind: t.kind,
        label: t.label,
        enabled: t.enabled
      })));

      // Check supported MIME types
      const mimeTypes = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm'
      ];
      
      console.log('[video] Checking MIME type support...');
      const supportedTypes = mimeTypes.filter(type => {
        const supported = MediaRecorder.isTypeSupported(type);
        console.log(`[video] ${type}: ${supported ? '✅ supported' : '❌ not supported'}`);
        return supported;
      });
      
      const options = { mimeType: supportedTypes[0] || 'video/webm' };
      console.log('[video] Using MIME type:', options.mimeType);

      // Create MediaRecorder
      console.log('[video] Creating MediaRecorder...');
      this.mediaRecorder = new MediaRecorder(this.stream, options);
      this.recordedChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.recordedChunks.push(event.data);
          console.log('[video] 📊 Data chunk received:', event.data.size, 'bytes, total chunks:', this.recordedChunks.length);
        }
      };

      this.mediaRecorder.onerror = (error) => {
        console.error('[video] ❌ MediaRecorder error:', error);
      };

      this.mediaRecorder.onstop = () => {
        console.log('[video] MediaRecorder stopped event fired');
      };

      this.mediaRecorder.onstart = () => {
        console.log('[video] ✅ MediaRecorder started event fired');
      };

      // Start recording
      console.log('[video] Calling mediaRecorder.start(1000)...');
      this.mediaRecorder.start(1000); // Capture in 1-second chunks
      this.isRecording = true;
      
      console.log('[video] ✅ Recording started successfully, state:', this.mediaRecorder.state);
      return { ok: true };
    } catch (err) {
      console.error('[video] ❌ Failed to start recording:', err);
      console.error('[video] Error name:', err.name);
      console.error('[video] Error message:', err.message);
      return { ok: false, error: err.message };
    }
  }

  async stopRecording() {
    try {
      console.log('[video] ===== STOPPING VIDEO RECORDING =====');
      console.log('[video] Current recording state:', this.isRecording);
      console.log('[video] MediaRecorder exists?', !!this.mediaRecorder);
      console.log('[video] MediaRecorder state:', this.mediaRecorder?.state);
      
      if (!this.mediaRecorder || !this.isRecording) {
        console.warn('[video] ⚠️ No active recording to stop');
        return { ok: false, error: 'No active recording' };
      }

      console.log('[video] Creating promise to wait for stop event...');

      return new Promise((resolve) => {
        this.mediaRecorder.onstop = () => {
          console.log('[video] ✅ MediaRecorder stop event fired');
          console.log('[video] Total chunks received:', this.recordedChunks.length);
          console.log('[video] Chunk sizes:', this.recordedChunks.map(c => c.size));
          
          // Create blob from chunks
          const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
          console.log('[video] ✅ Video blob created');
          console.log('[video] Blob size:', blob.size, 'bytes');
          console.log('[video] Blob type:', blob.type);

          // Stop all tracks
          if (this.stream) {
            console.log('[video] Stopping stream tracks...');
            this.stream.getTracks().forEach(track => {
              track.stop();
              console.log('[video] ✅ Track stopped:', track.kind, track.label);
            });
          }

          // Convert blob to base64
          console.log('[video] Converting blob to base64...');
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64data = reader.result;
            console.log('[video] ✅ Video converted to base64');
            console.log('[video] Base64 data length:', base64data.length);
            console.log('[video] Base64 prefix:', base64data.substring(0, 50));
            
            this.isRecording = false;
            this.mediaRecorder = null;
            this.stream = null;
            
            resolve({ 
              ok: true, 
              videoData: base64data,
              size: blob.size,
              mimeType: blob.type
            });
          };
          reader.onerror = (error) => {
            console.error('[video] ❌ Failed to convert to base64:', error);
            resolve({ ok: false, error: 'Failed to convert video' });
          };
          reader.readAsDataURL(blob);
        };

        console.log('[video] Calling mediaRecorder.stop()...');
        this.mediaRecorder.stop();
        console.log('[video] Stop() called, waiting for onstop event...');
      });
    } catch (err) {
      console.error('[video] ❌ Failed to stop recording:', err);
      console.error('[video] Error name:', err.name);
      console.error('[video] Error message:', err.message);
      return { ok: false, error: err.message };
    }
  }

  isCurrentlyRecording() {
    return this.isRecording;
  }
}

// Export singleton instance
export const videoRecorder = new VideoRecorder();
