require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "NitroList"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => package["repository"], :tag => "#{s.version}" }

  s.source_files = [
    "ios/**/*.{swift,h,m,mm}",
    # Shared C++ layout engine (also compiled on Android via CMake).
    # Non-recursive on purpose: cpp/tests/ is host-only.
    "cpp/*.{hpp,cpp}",
  ]
  # add_nitrogen_files sets public_header_files explicitly, which makes every
  # unlisted header private — and a private header is excluded from the
  # framework umbrella, so same-module Swift (LayoutManager.swift) would not
  # see NitroListLayoutCore. The bridge header must be listed as public here
  # (the nitrogen script merges with, not replaces, this list). It is plain
  # ObjC (no C++ leaks into the umbrella); the C++ stays in the .mm.
  s.public_header_files = [
    "ios/LayoutCoreBridge.h",
  ]
  s.private_header_files = [
    "cpp/*.hpp",
  ]

  load 'nitrogen/generated/ios/NitroList+autolinking.rb'
  add_nitrogen_files(s)

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  install_modules_dependencies(s)
end
