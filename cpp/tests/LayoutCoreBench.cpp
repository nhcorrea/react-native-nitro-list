#include "../LayoutCore.hpp"

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <vector>

using margelo::nitro::nitrolist::LayoutCore;

namespace {

volatile double sink = 0;
double clockMs = 0;

double nextClock() {
  clockMs += 1000.0 / 60.0;
  return clockMs;
}

double offsetFor(int index) {
  const int phase = index % 1200;
  return (phase <= 600 ? phase : 1200 - phase) * (2000.0 / 30.0);
}

std::vector<double> sizes(int32_t count) {
  std::vector<double> pairs;
  pairs.reserve(static_cast<size_t>(count) * 2);
  for (int32_t index = 0; index < count; ++index) {
    const auto height = 52 + ((static_cast<uint32_t>(index) * 2654435761U) % 109);
    pairs.push_back(index);
    pairs.push_back(height * 2.0);
  }
  return pairs;
}

template <typename Fn>
double measure(Fn&& fn) {
  for (int index = 0; index < 500; ++index) fn(index);
  const auto start = std::chrono::steady_clock::now();
  for (int index = 0; index < 2000; ++index) fn(index);
  const auto end = std::chrono::steady_clock::now();
  return std::chrono::duration<double, std::nano>(end - start).count() / 2000;
}

double scenario(const std::vector<double>& fixture, bool slab) {
  LayoutCore core;
  core.setTypeAverages(true);
  core.setDirectionalBuffers(true);
  core.setEstimate(100);
  core.setItemCount(static_cast<int32_t>(fixture.size() / 2));
  core.setItemSizes(fixture.data(), static_cast<int32_t>(fixture.size() / 2), 1.0);
  clockMs = 0;
  core.setClockForTesting(nextClock);
  std::vector<double> output(512);
  return measure([&](int index) {
    const double offset = offsetFor(index);
    if (slab) {
      const auto written = core.fillLayoutSlab(output.data(), static_cast<int32_t>(output.size()), offset, 1257, 500, 1.0);
      if (written < 0) std::abort();
      sink = sink + written + output[8];
    } else {
      const auto range = core.getEngagedRange(offset, 1257, 500);
      sink = sink + range.start + range.end + range.version;
    }
  });
}

void summarize(const char* name, int32_t count, const std::vector<double>& samples) {
  std::vector<double> sorted = samples;
  std::sort(sorted.begin(), sorted.end());
  std::printf("SUMMARY %s %d %.1f %.1f %.1f\n", name, count, sorted[sorted.size() / 2], sorted.front(), sorted.back());
}

void run(int32_t count) {
  const auto fixture = sizes(count);
  for (const bool slab : {false, true}) {
    std::vector<double> samples;
    for (int repetition = 0; repetition < 9; ++repetition) {
      const auto ns = scenario(fixture, slab);
      samples.push_back(ns);
      std::printf("SAMPLE %s %d %d %.1f\n", slab ? "slab" : "range", count, repetition, ns);
    }
    summarize(slab ? "slab" : "range", count, samples);
  }
}

}

int main() {
  run(10000);
  run(100000);
  std::printf("SINK %.1f\n", sink);
}
