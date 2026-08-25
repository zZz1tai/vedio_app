cmake_minimum_required(VERSION 3.22.1)
project(expo_video_ai)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(RIFE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/rife")

function(video_ai_add_shader_header shader_source)
  get_filename_component(shader_name "${shader_source}" NAME_WE)
  file(READ "${shader_source}" shader_content)
  string(FIND "${shader_content}" "#version" shader_start)
  if(shader_start EQUAL -1)
    message(FATAL_ERROR "Missing #version directive in ${shader_source}")
  endif()
  string(SUBSTRING "${shader_content}" ${shader_start} -1 shader_content)
  string(REGEX REPLACE "\n +" "\n" shader_content "${shader_content}")
  set(shader_text "${CMAKE_CURRENT_BINARY_DIR}/${shader_name}.text2hex.txt")
  set(shader_header "${CMAKE_CURRENT_BINARY_DIR}/${shader_name}.comp.hex.h")
  file(WRITE "${shader_text}" "${shader_content}")
  file(READ "${shader_text}" shader_hex HEX)
  string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," shader_hex "${shader_hex}")
  string(FIND "${shader_hex}" "," shader_tail REVERSE)
  string(SUBSTRING "${shader_hex}" 0 ${shader_tail} shader_hex)
  file(WRITE "${shader_header}" "static const char ${shader_name}_comp_data[] = {${shader_hex}};\n")
endfunction()

file(GLOB RIFE_SHADERS "${RIFE_DIR}/*.comp")
foreach(shader ${RIFE_SHADERS})
  video_ai_add_shader_header("${shader}")
endforeach()

add_library(ncnn SHARED IMPORTED)
set_target_properties(ncnn PROPERTIES
  IMPORTED_LOCATION "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libncnn.so"
)

add_library(video_ai SHARED
  video_ai_jni.cpp
  "${RIFE_DIR}/rife.cpp"
  "${RIFE_DIR}/warp.cpp"
)

target_include_directories(video_ai PRIVATE
  "${CMAKE_CURRENT_BINARY_DIR}"
  "${CMAKE_CURRENT_SOURCE_DIR}/third_party/ncnn/include/ncnn"
  "${RIFE_DIR}"
)

target_compile_options(video_ai PRIVATE -Wall -Wextra -Wno-unused-parameter -fno-rtti)

find_library(android-lib android)
find_library(log-lib log)
find_library(jnigraphics-lib jnigraphics)
find_library(vulkan-lib vulkan)

target_link_libraries(video_ai
  ncnn
  ${android-lib}
  ${log-lib}
  ${jnigraphics-lib}
  ${vulkan-lib}
)
