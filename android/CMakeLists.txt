project(NitroList)
cmake_minimum_required(VERSION 3.9.0)

set (PACKAGE_NAME NitroList)
set (CMAKE_VERBOSE_MAKEFILE ON)
set (CMAKE_CXX_STANDARD 20)

file(GLOB_RECURSE android_files RELATIVE ${CMAKE_SOURCE_DIR}
     "src/main/cpp/**.cpp"
)

add_library(${PACKAGE_NAME} SHARED
            ${android_files}
            ../cpp/LayoutCore.cpp
)

include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/NitroList+autolinking.cmake)

include_directories(
        "src/main/cpp"
        "../cpp"
)

find_library(LOG_LIB log)

target_link_libraries(
        ${PACKAGE_NAME}
        ${LOG_LIB}
        android
)

target_link_options(${PACKAGE_NAME} PRIVATE "-Wl,-z,max-page-size=16384")
