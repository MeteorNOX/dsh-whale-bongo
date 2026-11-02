// Window geometry and mouse-button state only. No screenshots, window titles,
// keyboard capture, Accessibility permission, or Screen Recording prompt.
#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#include <signal.h>
#include <unistd.h>
#include <time.h>

static double nowSeconds(void) {
  struct timespec time;
  clock_gettime(CLOCK_MONOTONIC, &time);
  return time.tv_sec + time.tv_nsec / 1e9;
}

static BOOL emit(NSDictionary *message) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:message options:0 error:nil];
  if (!data || fwrite(data.bytes, 1, data.length, stdout) != data.length) return NO;
  if (fputc('\n', stdout) == EOF) return NO;
  return fflush(stdout) == 0;
}

int main(int argc, const char *argv[]) {
  signal(SIGPIPE, SIG_IGN);
  const pid_t parent = getppid();
  const pid_t helper = argc > 1 ? (pid_t)atoi(argv[1]) : parent;
  const BOOL once = argc > 2 && strcmp(argv[2], "--once") == 0;
  double nextMouse = 0, nextWindows = 0, hotUntil = 0, lastWindowEmit = 0;
  NSArray *lastWindows = nil;
  do {
    @autoreleasepool {
      if (getppid() != parent) break;
      double now = nowSeconds();
      NSMutableDictionary *sample = [NSMutableDictionary dictionary];
      CGEventRef event = now >= nextMouse ? CGEventCreate(NULL) : NULL;
      if (now >= nextMouse) nextMouse = now + 0.016;
      if (event) {
        CGPoint point = CGEventGetLocation(event);
        CFRelease(event);
        sample[@"mouse"] = @{
          @"x": @(point.x), @"y": @(point.y),
          @"left": @(CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft))
        };
      }
      if (now >= nextWindows) {
        NSArray *list = CFBridgingRelease(CGWindowListCopyWindowInfo(
          kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
        NSMutableArray *windows = [NSMutableArray array];
        for (NSDictionary *window in list) {
          NSNumber *pid = window[(id)kCGWindowOwnerPID];
          if (pid.intValue == helper || pid.intValue == getpid()) continue;
          if ([window[(id)kCGWindowLayer] intValue] != 0) continue;
          if ([window[(id)kCGWindowAlpha] doubleValue] <= 0) continue;
          CGRect bounds;
          if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &bounds)) continue;
          if (bounds.size.width < 40 || bounds.size.height < 40) continue;
          NSNumber *number = window[(id)kCGWindowNumber];
          if (!number) continue;
          // Quartz global screen coordinates are already logical points on Mac.
          [windows addObject:@{
            @"hwnd": [@"mac:" stringByAppendingString:number.stringValue],
            @"title": window[(id)kCGWindowOwnerName] ?: @"",
            @"left": @(CGRectGetMinX(bounds)), @"top": @(CGRectGetMinY(bounds)),
            @"right": @(CGRectGetMaxX(bounds)), @"bottom": @(CGRectGetMaxY(bounds))
          }];
        }
        BOOL changed = ![windows isEqualToArray:lastWindows];
        if (changed) {
          lastWindows = [windows copy];
          hotUntil = now + 0.5;
        }
        // Keep a heartbeat for the renderer's missing-window grace period.
        if (changed || now - lastWindowEmit >= 0.5) {
          sample[@"windows"] = windows;
          lastWindowEmit = now;
        }
        // Match the Windows sampler: follow quickly while moving, back off
        // when still, and avoid restarting placement for unchanged geometry.
        nextWindows = now + (now < hotUntil ? 0.012 : 0.033);
      }
      if (sample.count && !emit(sample)) break;
      if (!once) {
        double wait = MIN(nextMouse, nextWindows) - nowSeconds();
        usleep((useconds_t)(MAX(0.001, wait) * 1e6));
      }
    }
    if (once) break;
  } while (YES);
  return 0;
}
