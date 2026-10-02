#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void fail(const char *message) { fprintf(stderr, "%s\n", message); exit(1); }
static void checked_close(int fd) { if (close(fd) != 0) fail("secure create close failed"); }

static int open_workspace(const char *path, const char *device, const char *inode) {
  char *end = NULL;
  errno = 0;
  unsigned long long expected_device = strtoull(device, &end, 10);
  if (errno != 0 || end == device || *end != '\0') fail("workspace identity is invalid");
  errno = 0;
  unsigned long long expected_inode = strtoull(inode, &end, 10);
  if (errno != 0 || end == inode || *end != '\0') fail("workspace identity is invalid");
  int directory = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory < 0) fail("workspace directory is unavailable");
  struct stat info;
  if (fstat(directory, &info) != 0 || !S_ISDIR(info.st_mode) || (unsigned long long)info.st_dev != expected_device || (unsigned long long)info.st_ino != expected_inode) fail("workspace identity changed after approval");
  return directory;
}

static int open_parent(int workspace, const char *path, char **leaf) {
  char *copy = strdup(path);
  if (copy == NULL) fail("secure create allocation failed");
  int directory = dup(workspace);
  if (directory < 0) fail("workspace directory is unavailable");
  char *part = copy;
  char *next;
  while ((next = strchr(part, '/')) != NULL) {
    *next = '\0';
    int child = openat(directory, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    checked_close(directory);
    if (child < 0) fail("create parent is unavailable or a symlink");
    directory = child;
    part = next + 1;
  }
  *leaf = strdup(part);
  free(copy);
  if (*leaf == NULL || **leaf == '\0') fail("create path is unavailable");
  return directory;
}

int main(int argc, char **argv) {
  if (argc != 6) fail("secure create arguments are invalid");
  const char *operation = argv[1];
  int workspace = open_workspace(argv[2], argv[3], argv[4]);
  char *leaf;
  int parent = open_parent(workspace, argv[5], &leaf);
  if (strcmp(operation, "mkdir") == 0) {
    if (mkdirat(parent, leaf, 0700) != 0) fail("directory could not be created");
  } else if (strcmp(operation, "touch") == 0) {
    int file = openat(parent, leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (file < 0) fail("file could not be created");
    checked_close(file);
  } else fail("secure create operation is invalid");
  free(leaf);
  checked_close(parent);
  checked_close(workspace);
  return 0;
}
